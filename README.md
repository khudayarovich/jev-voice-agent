# JVA — Jev Voice Agent

[![CI](https://github.com/khudayarovich/jev-voice-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/khudayarovich/jev-voice-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

Realtime voice control for macOS, routed by **Jev** — TypeSafe AI's System One model.

Say *"Hey Jeff"*, speak a command, and it runs — typically **~0.45 s after you
stop talking**, and for a chained request like *"open Notes and create a new
note"*, Notes opens **before you have finished the sentence**. Feedback is a
small overlay under the menu bar and short indicator tones; there is no talking
assistant.

## Install

Download **`JevVoiceAgent-<version>-arm64.dmg`** from
[Releases](https://github.com/khudayarovich/jev-voice-agent/releases), open it,
and drag **Jev Voice Agent** into Applications. It needs an Apple Silicon Mac
with macOS 14 or later.

The first time, macOS will not open it, because the build is not notarized by
Apple (that takes a paid developer account). Allow it once: try to open the app,
then go to **System Settings → Privacy & Security** and click **Open Anyway**.

It lives in the menu bar. On first launch Settings opens, and the speech model
(~500 MB) starts downloading in the background while you do two things:

1. **Connection** — paste a [TypeSafe](https://typesafe.ai) API key for Jev.
   Without one, a local matcher still handles the common commands, just more
   bluntly.
2. **Permissions** — grant Microphone and Accessibility. macOS asks for
   Automation separately, per app, the first time a command needs it.

Then say *"Hey Jeff, open Safari"*. Or *"Hey Jeff, set the volume to thirty
percent"*, *"take a selfie"*, *"search YouTube for lofi music"*, *"open
Bluetooth settings"*, *"open Notes and create a new note"*. Keep talking after
the first command — no wake word needed until you say "that's it". The full list
is under Settings → Commands.

If something seems off, this checks every part of the install without touching
the microphone:

```bash
"/Applications/Jev Voice Agent.app/Contents/MacOS/Jev Voice Agent" --self-test
```

## Run from source

You need [Node.js](https://nodejs.org) 22 or later, and the Xcode command line
tools and CMake to build the speech engine:

```bash
xcode-select --install     # if you do not have them yet
brew install cmake
```

Then:

```bash
git clone https://github.com/khudayarovich/jev-voice-agent.git
cd jev-voice-agent
npm install
npm run setup    # builds whisper.cpp and the clicking helper, downloads the models (~500 MB, once)
npm start
```

To build the installer yourself, `npm run dist` produces
`release.noindex/JevVoiceAgent-<version>-arm64.dmg` (the `.noindex` keeps the
unpacked app it also leaves there out of Spotlight, so search finds only the
installed copy), with a self-contained speech engine
built for any Apple Silicon Mac. Set `CSC_NAME` to a Developer ID certificate to
sign it properly; otherwise it is signed ad hoc.

## How it works

```
mic → VAD → local STT, while you speak  → wake phrase in the transcript?
          → at every pause: transcribe it all, route it, act if it is complete
          → finished clauses of a chain run mid-sentence
    → ONE Jev systemOne call per clause → confidence gate → typed executor
    → conversation stays open: keep talking, no wake word needed
```

### Realtime

The agent does not wait for you to finish, then transcribe, then think. It
works while you talk:

- **Transcribing as you speak.** With a fast model (Small or Base, ~150 ms a
  pass) the audio is transcribed every ~0.6 s while you are still talking. That
  drives the live text in the overlay, lights it up the moment "Hey Jeff" is
  heard, and routes the command *before* you stop when the words already look
  complete — so the answer is usually waiting by the time you do.
- **Acting at the pause, not after the silence.** ~0.2 s after you stop, what you
  said is transcribed and routed. If it is a complete, confident command it runs
  right then. A pause that sounds unfinished ("set the volume to…", "open my…")
  is given longer, so a thinking pause does not cut you off.
- **Chains, mid-sentence.** A clause followed by "and"/"then" plus more speech is
  finished, so it runs while you say the rest. Execution always follows the
  order you spoke in, and waits for an app you just opened to come to the front
  before the next clause sends it keystrokes.
- **Instant commands.** Exact commands — "open Safari", "mute", "next track",
  "take a screenshot" — run on the Mac without a network round trip. Anything
  looser, anything destructive, and anything that needs choosing from a list
  still goes to Jev. Switch it off in Settings → Voice.
- **A warm line to Jev.** Requests go through Chromium's network stack, which
  keeps an HTTP/2 session open between commands, and the connection is opened
  the moment anyone starts talking. Measured from here: 781 ms per route with
  Node's fetch and commands a few seconds apart, 307 ms this way.

The wake phrase is matched **in the transcript**, not by a keyword spotter. A
spotter was tried first and measured: the same phrase at ordinary speaking
volume was missed at every threshold, while whisper — already running, and
returning in ~65 ms — recognises it dependably. The spotter is still there as an
optional fast path that lights the overlay early when it does fire, but nothing
depends on it. While the wake word is off, no ambient speech is transcribed at
all.

Say "Hey Jeff" once and the conversation stays open: keep giving commands until
you say "that's it", "thanks", or "that's all", or until it goes quiet. The
menu-bar icon shows sound waves the whole time it is still listening.

The approach was inspired by Andy Gao's voice-controlled Mac built on Jev, where
"the app opens before I even finish my sentence".

### Understanding what you mean

People describe more than they name, and they talk in a sequence, not in
isolated commands. What real use turned up, and what the agent does about it:

- **Describe it, don't name it.** Every installed app goes to Jev with a line
  saying what it is for — Photo Booth is the camera app, Finder the file
  manager, Activity Monitor the task manager — so *"open my camera"*, *"open the
  password manager"* or *"open the file manager"* find the right one, including
  apps you have never opened.
- **One browser, the one you are using.** A link or a search opens in the
  browser you named (*"open YouTube in Chrome"*), else the one in front, else the
  one you just used, else one with a window open, and only then the system
  default. *"The browser"* follows the same rule. *"Close all browsers"* means all
  of them.
- **In the tab you are on.** A search or a link goes into the tab in front when
  it holds nothing worth keeping — an empty tab, a page of results, the page it
  just opened — and into a new tab of the same window otherwise. Never a new
  window. So *"open browser"*, *"search for YouTube"*, *"open YouTube"* happens
  in one tab, the way you would do it. (The first time, macOS asks to let JVA
  control Safari or Chrome.)
- **Click what you see.** *"Click YouTube"*, *"click the first result"*, *"click
  Sign in"*, *"press the Continue button"* press it on screen, found through
  Accessibility — in a web page or any app. *"Search for cats and click the first
  result"* works in one breath. Buttons like Delete, Send or Buy ask first.
- **Sites, not searches for sites.** *"Search for youtube.com"* opens YouTube.
  *"Search YouTube for cats"*, *"play lofi music on YouTube"* and *"look up pizza
  on Google Maps"* go to that site's own search; *"search for cats there"* searches
  the site in front.
- **The camera and the settings.** *"Take a selfie"* opens Photo Booth and
  presses its shutter (with its three-second countdown). *"Open Bluetooth
  settings"*, *"turn on Wi-Fi"* or *"change my wallpaper"* open that page of System
  Settings directly.
- **It asks, and remembers asking.** When it cannot tell which app you meant, it
  asks — *"Which one — Xcode or Cursor?"* — and your answer finishes the original
  command. *"Quit Safari? Say yes to confirm."* names what it is about to do, and
  answering with a different command does that command instead.
- **Short-term memory.** Each request carries what the conversation just did, so
  *"close it"* has something to refer to.

Everything from the microphone to the transcript runs **on this machine**. Only
the routing decision — a short transcript plus a small structured context
object — is sent to Jev.

### Why Jev, and what it changes

Jev is not a text-generating LLM. It evaluates a `state` and returns *typed
decisions with calibrated probabilities*: a `choice`, a `score`, or a `noul`
(yes/no). It cannot write an AppleScript or invent an app name.

So the usual "LLM writes code" design is inverted:

> The model never emits code or free text. It selects an index into a static,
> hand-written action registry. Numbers and text payloads are parsed
> deterministically in code, never generated.

That is both why it is fast (70–500 ms, ~0.003¢ per command) and why it is safe.

## Status

- [x] **Phase 1** — skeleton, tray, settings, permissions, earcons
- [x] **Phase 2** — audio capture → transcript (~65 ms on an M4 Pro)
- [x] **Phase 3** — wake word, VAD endpointing, auto-gain
- [x] **Phase 4** — Jev routing, typed executor, confirmations
- [x] **Realtime** — streaming transcription, acting at the pause, chains mid-sentence
- [x] **Installable app** — a DMG with a self-contained speech engine; the model downloads on first run
- [x] **Understanding** — apps described, one browser, sites and site searches, camera and settings pages, clarifying questions
- [ ] **Phase 5** — wider registry, native helper for hold-to-talk
- [ ] **Phase 6** — Apple SpeechAnalyzer engine, notarization

## Measured on an M4 Pro

`npm run bench` speaks a set of commands with the system voices and replays them
through the real pipeline — Silero VAD, whisper-server, Jev over the network — at
real-time pace, without executing anything. It reports when each action would
have run, counted from the end of speech:

| model | correct | after end of speech | chains |
|---|---|---|---|
| **small.en** (recommended) | 20/20 | **p50 451 ms**, p90 660 ms | first clause runs ~0.6–0.9 s *before* the sentence ends |
| large-v3-turbo | 20/20 | p50 874 ms, p90 1.3 s | run at the pause (too slow to stream) |

Before the realtime work, the same machine logged 3.5–3.9 s from the end of
"Hey Jeff, open Claude" to Claude opening. Where that went:

| | before | now |
|---|---|---|
| waiting to decide you had stopped | 1.4 s (a 0.7 s VAD hangover *plus* a 0.7 s endpoint) | ~0.2 s, then act at the pause |
| gathering context (osascript) | ~330 ms, after the transcript | ~30 ms (`lsappinfo`), while you speak |
| Jev: cold TLS handshake per command | ~460 ms | 0 — HTTP/2 kept warm, preconnected |
| Jev: second round trip for the app name | ~400 ms | 0 — one request answers everything |

| Stage | Time |
|---|---|
| Transcription, small.en + Metal | ~150 ms |
| Jev routing, warm (network RTT here ~220 ms) | ~310 ms |
| Cost | ~$0.08 per 1000 commands; about twice that when the request is about an app, since every installed app goes along, described |

### Routing accuracy

`npm run calibrate` replays 50 labelled commands through the real API:

```
accuracy          100.0%  (50/50)
local matcher      96.0%  (the offline fallback, for comparison)
confidence  hit   mean 0.980   p10 0.970
latency           mean 489ms   p50 410ms   p95 1222ms
tokens            1901 per command
```

`npm run eval` checks understanding on this Mac, with its real app list: 56
requests that describe rather than name, involve browsers and clicking, chain
two commands, or sit close to another command — including every one that went
wrong in real use ("open selfie camera", "search for youtube.com", "close all
browsers", "take a photo", "open YouTube" on a page of results). Nothing is
executed:

```
56/56 right   routing p50 317 ms   p90 623 ms   3912 input tokens per request
```

Confidence is well separated: before the criteria were tightened, the two wrong
answers sat at 0.53 while every correct one was above 0.97 — so the default
0.55 gate refused exactly the wrong answers and nothing else. That is why the
threshold is set where it is, and re-running this is how to move it.

The focused app measurably helps. "copy that" is ambiguous on its own
(confidence 0.50 in Finder), rises to 0.63 in a code editor, and in Messages the
*addressed* score falls to 0.29 — the model correctly suspects you may be
talking to a person, and the agent stays quiet.

## Speech recognition

Runs on this Mac via whisper.cpp, selectable in Settings. Measured here over
spoken commands naming real installed applications — the case that actually
fails, since nearly every recognition error is a proper noun:

| model | no prompt | with vocabulary prompt | latency |
|---|---|---|---|
| base.en | 38.9% WER | 13.9% | 54 ms |
| **small.en** (default) | 22.2% WER | **5.6%** | 145 ms |
| large-v3-turbo | 22.2% WER | 23.6% | 604 ms |

With realtime, speed counts twice: a model fast enough to transcribe *while you
talk* (Small or Base) is what lets a command run as you finish and a chain run
mid-sentence. At ~600 ms a pass large-v3-turbo cannot keep up, so it only
transcribes at your pause — about twice as slow to respond as Small.

Two results worth keeping in mind. **The vocabulary prompt matters more than the
model** — it more than halved the error rate for every English model. And
**bigger is not better**: `large-v3-turbo` is multilingual while the `.en` models
are English-specialised, so on English application names the small English model
beats it outright at a quarter of the latency. It stays available because
multilingual training is what helps with a strong accent.

The prompt is built from *your* apps, ranked by how recently you launched each
one (via Spotlight), because whisper's prompt only fits about sixty names and
cutting the list alphabetically would drop Safari, Slack and Terminal while
keeping every utility beginning with "A".

**Names are repaired after transcription too.** Recognisers fail on proper nouns
in a specific way — the consonants survive and the vowels wander. "Claude" comes
back as "clawed", "clod", "cloudy"; "Termius" as "termias". Since this machine
knows exactly which applications exist, the transcript is matched against them on
a consonant skeleton ("claude", "clawed" and "cloudy" all reduce to `cld`) and
repaired before anything else reads it. That works whichever model is running,
which matters more than picking the right one.

## Things it handles that are easy to get wrong

- **Described, not named.** "open the browser" resolves to your actual browser.
  Jev reads criteria literally, so the slot question says outright that a
  description counts — without that it answered "the user named none of these"
  and refused the command at full confidence.
- **Chained requests.** "open Firefox and open YouTube" runs both. Splitting is
  refused when the conjunction belongs to a payload, so "type hello and goodbye"
  stays one command.
- **Sites vs apps.** "open YouTube" is a website; there is no YouTube.app to
  find. Well-known sites route to the browser instead.

## Commands

61 built in, plus every Shortcut you have written — those are
discovered at runtime and become voice-callable with no code change. See
Settings → Commands.

## Development

```bash
npm start           # build and launch
npm test            # hermetic tests, no microphone or network needed
npm run typecheck
npm run bench       # realtime latency through the real pipeline (needs the API key)
npm run eval        # does it understand? real requests against this Mac's apps (needs the API key)
npm run calibrate   # routing accuracy against the live API (TYPESAFE_API_KEY=...)
npm run assets      # regenerate the tray icons and indicator tones
npm run tail        # follow the structured log while you talk to it
```

Development runs inside Electron's own bundle (`com.github.Electron`), whose
signature is stable between rebuilds — so macOS permission grants stick. A
Developer ID is needed before distributing; see Settings → Permissions.

Issues and pull requests are welcome. The action registry
(`src/main/actions/registry.ts`) is the place to start: every command is one
typed entry there, and Jev can only ever choose among them.

## Credits

- [Jev](https://typesafe.ai) by TypeSafe AI routes every command.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) transcribes on-device.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache 2.0) runs the
  [Silero VAD](https://github.com/snakers4/silero-vad) (MIT) and the wake-word spotter.
- [Electron](https://www.electronjs.org) (MIT).

The models are downloaded by `npm run setup` and are not part of this repository.

## License

[MIT](LICENSE) © 2026 Farrukh Khudayarovich Yuldashev.

Made by **Farrukh Yuldashev**.
