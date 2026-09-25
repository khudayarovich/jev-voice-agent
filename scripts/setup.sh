#!/usr/bin/env bash
# Fetches and builds everything JVA needs that is too large for git:
#
#   - whisper.cpp's whisper-server, built for this Mac with Metal
#   - a speech-to-text model (small.en unless you choose another)
#   - the Silero voice-activity model
#   - the sherpa-onnx keyword-spotter model used for the wake word
#   - jev-ax, the small native helper that clicks things on screen
#
#   npm run setup                         # everything, with small.en
#   npm run setup -- --model base.en      # a different speech model
#   npm run setup -- --only kws           # just some: whisper, model, vad, kws, ax, portable
#   npm run setup -- --only portable,vad  # (comma-separated; portable is what `npm run dist` ships)
#
# Safe to run again: anything already in place is left alone. Other speech
# models can also be downloaded later from Settings → Voice.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS="$ROOT/resources/models"
WHISPER="$ROOT/vendor/whisper.cpp"
# Pinned: the server's flags and behaviour are what the app was measured with.
WHISPER_TAG="v1.9.4"
KWS="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
MODEL="small.en"
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:?--model needs a name}"; shift 2 ;;
    --only) ONLY="${2:?--only needs a piece}"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case "$MODEL" in
  base.en) MODEL_FILE="ggml-base.en.bin" ;;
  small.en) MODEL_FILE="ggml-small.en.bin" ;;
  large-v3-turbo-q5) MODEL_FILE="ggml-large-v3-turbo-q5_0.bin" ;;
  *) echo "Unknown model: $MODEL (choose base.en, small.en or large-v3-turbo-q5)" >&2; exit 2 ;;
esac

for piece in ${ONLY//,/ }; do
  case "$piece" in
    whisper | model | vad | kws | ax | portable) ;;
    *) echo "Unknown piece: $piece (choose whisper, model, vad, kws, ax or portable)" >&2; exit 2 ;;
  esac
done

step() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
# Everything by default; with --only, just the pieces named. The portable
# server is only ever built on request: development never needs it.
want() { [[ -z "$ONLY" || ",$ONLY," == *",$1,"* ]]; }
asked() { [[ ",$ONLY," == *",$1,"* ]]; }

# Download through a temporary file, so an interrupted download never looks
# like an installed one.
download() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  curl --fail --location --retry 3 --progress-bar -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "JVA runs on macOS only." >&2
  exit 1
fi

# Build whisper-server into "$WHISPER/$1", with any extra CMake flags after it.
build_server() {
  local dir="$1"
  shift
  command -v cmake >/dev/null || { echo "CMake is needed to build whisper.cpp: brew install cmake" >&2; exit 1; }
  xcode-select -p >/dev/null 2>&1 || { echo "The Xcode command line tools are needed: xcode-select --install" >&2; exit 1; }
  if [[ ! -d "$WHISPER/.git" ]]; then
    step "Fetching whisper.cpp $WHISPER_TAG"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WHISPER_TAG" \
      https://github.com/ggml-org/whisper.cpp "$WHISPER"
  fi
  # Apple's clang has no OpenMP; whisper.cpp's own thread pool is what runs.
  cmake -S "$WHISPER" -B "$WHISPER/$dir" -Wno-dev -Wno-deprecated \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DGGML_OPENMP=OFF "$@" >/dev/null
  cmake --build "$WHISPER/$dir" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu)" >/dev/null
  step "Built $WHISPER/$dir/bin/whisper-server"
}

if want whisper; then
  if [[ -x "$WHISPER/build/bin/whisper-server" ]]; then
    step "whisper-server is already built"
  else
    step "Building whisper-server with Metal (a minute or two)"
    build_server build
  fi
fi

# The copy that ships inside the app. The development build links six
# libraries by an absolute path on this disk and tunes its CPU code to this
# exact chip; this one links nothing but the system, embeds its Metal shaders,
# and runs on any Apple Silicon Mac.
if asked portable; then
  if [[ -x "$WHISPER/build-portable/bin/whisper-server" ]]; then
    step "Portable whisper-server is already built"
  else
    step "Building the portable whisper-server for the app bundle"
    # macOS 14 is the app's floor: the sherpa-onnx addon needs it. Without an
    # explicit target the binary is stamped with whatever macOS built it.
    build_server build-portable -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL_EMBED_LIBRARY=ON \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
  fi
fi

if want model; then
  if [[ -s "$MODELS/$MODEL_FILE" ]]; then
    step "Speech model $MODEL is already downloaded"
  else
    step "Downloading speech model $MODEL"
    download "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE" "$MODELS/$MODEL_FILE"
  fi
fi

if want vad; then
  if [[ -s "$MODELS/silero_vad.onnx" ]]; then
    step "Voice-activity model is already downloaded"
  else
    step "Downloading the voice-activity model"
    download "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" "$MODELS/silero_vad.onnx"
  fi
fi

if want kws; then
  if [[ -s "$MODELS/$KWS/tokens.txt" ]]; then
    step "Wake-word model is already downloaded"
  else
    step "Downloading the wake-word model"
    download "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$KWS.tar.bz2" "$MODELS/$KWS.tar.bz2"
    tar -xjf "$MODELS/$KWS.tar.bz2" -C "$MODELS"
    rm -f "$MODELS/$KWS.tar.bz2"
  fi
fi

if want ax; then
  AX_SRC="$ROOT/native/jev-ax/main.swift"
  AX_BIN="$ROOT/vendor/jev-ax/jev-ax"
  if [[ -x "$AX_BIN" && "$AX_BIN" -nt "$AX_SRC" ]]; then
    step "The clicking helper is already built"
  else
    xcode-select -p >/dev/null 2>&1 || { echo "The Xcode command line tools are needed: xcode-select --install" >&2; exit 1; }
    step "Building the clicking helper"
    mkdir -p "$(dirname "$AX_BIN")"
    # macOS 14 is the app's floor, as for the speech engine.
    xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14.0 -o "$AX_BIN" "$AX_SRC"
  fi
fi

if [[ -z "$ONLY" ]]; then
  step "All set. Start JVA with: npm start"
fi
