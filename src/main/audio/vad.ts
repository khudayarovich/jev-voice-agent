import { existsSync } from "node:fs";
import { type SherpaVad, loadSherpa, modelDir } from "./sherpa.ts";
import { SAMPLE_RATE } from "./wav.ts";

/**
 * Silero VAD, used for two jobs:
 *
 *  1. **Endpointing** — deciding when the user stopped talking, so a command can
 *     be sent for transcription without waiting for a fixed timeout.
 *  2. **The second factor on a wake trigger.** A wake fires only on a high
 *     keyword score AND concurrent speech, which is the documented defence
 *     against the keyword spotter firing on noise.
 *
 * It costs well under 1 ms per window on one core, so it runs always-on.
 */

/** Silero v5 requires EXACTLY this window size at 16 kHz. Anything else returns garbage. */
export const VAD_WINDOW = 512;

export interface VadOptions {
  /** Speech probability above which a frame counts as speech. */
  threshold?: number;
  /** Trailing silence that ends an utterance, seconds. */
  minSilence?: number;
  /** Utterances shorter than this are discarded — coughs, clicks, door slams. */
  minSpeech?: number;
  /** Hard cap so a stuck-open mic cannot buffer forever, seconds. */
  maxSpeech?: number;
}

export interface SpeechSegment {
  /** Sample offset of the segment start within the stream. */
  start: number;
  samples: Float32Array;
}

export class Vad {
  private vad: SherpaVad | null = null;
  /** Carries the remainder when a chunk is not a multiple of VAD_WINDOW. */
  private pending = new Float32Array(0);

  private readonly opts: VadOptions;

  constructor(opts: VadOptions = {}) {
    this.opts = opts;
  }

  get available(): boolean {
    return this.vad !== null;
  }

  start(): boolean {
    if (this.vad) return true;
    const sherpa = loadSherpa();
    if (!sherpa) return false;
    const model = modelDir("silero_vad.onnx");
    if (!existsSync(model)) {
      console.error("[vad] missing model:", model);
      return false;
    }
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model,
          threshold: this.opts.threshold ?? 0.5,
          minSilenceDuration: this.opts.minSilence ?? 0.5,
          minSpeechDuration: this.opts.minSpeech ?? 0.25,
          maxSpeechDuration: this.opts.maxSpeech ?? 12,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      30, // seconds of internal buffer
    );
    return true;
  }

  /**
   * Feed arbitrary-length audio. Chunks are re-cut to exactly VAD_WINDOW samples
   * because Silero is strict about it, and the capture side has no reason to
   * know that.
   */
  accept(samples: Float32Array): SpeechSegment[] {
    if (!this.vad) return [];

    let buf: Float32Array;
    if (this.pending.length) {
      buf = new Float32Array(this.pending.length + samples.length);
      buf.set(this.pending, 0);
      buf.set(samples, this.pending.length);
    } else {
      buf = samples;
    }

    let offset = 0;
    for (; offset + VAD_WINDOW <= buf.length; offset += VAD_WINDOW) {
      this.vad.acceptWaveform(buf.subarray(offset, offset + VAD_WINDOW));
    }
    this.pending = buf.slice(offset);

    return this.drain();
  }

  /** True while the model currently believes someone is speaking. */
  get speaking(): boolean {
    return this.vad?.isDetected() ?? false;
  }

  /** Force any buffered speech out, e.g. when the user stops a capture manually. */
  flush(): SpeechSegment[] {
    if (!this.vad) return [];
    this.vad.flush();
    return this.drain();
  }

  private drain(): SpeechSegment[] {
    if (!this.vad) return [];
    const out: SpeechSegment[] = [];
    while (!this.vad.isEmpty()) {
      // `false` = do NOT hand back an externally-backed ArrayBuffer.
      //
      // The addon defaults this to true, which works in plain Node but throws
      // "External buffers are not allowed" inside Electron: Electron enables the
      // V8 sandbox, and sandboxed V8 refuses ArrayBuffers whose memory lives
      // outside the sandbox. It threw on the first frame of real speech, took
      // down the main process behind a modal dialog, and — because frames arrive
      // ~15x a second — would have repeated forever. Passing false copies the
      // samples into a normal buffer instead.
      const seg = this.vad.front(false);
      out.push({ start: seg.start, samples: seg.samples });
      this.vad.pop();
    }
    return out;
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.vad?.reset();
    this.vad?.clear();
  }

  stop(): void {
    this.vad = null;
    this.pending = new Float32Array(0);
  }
}
