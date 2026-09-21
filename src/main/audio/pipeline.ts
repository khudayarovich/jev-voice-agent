import { EventEmitter } from "node:events";
import type { AppSettings } from "../../shared/types.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { SAMPLE_RATE, int16ToFloat32 } from "./wav.ts";
import type { SpeechEngine } from "./whisper.ts";

/**
 * The listening loop.
 *
 * ```
 * frames → ring buffer (1.5 s pre-roll)
 *        → [armed]     wake word + VAD  →  trigger
 *        → [capturing] accumulate + endpoint on trailing silence
 *        → transcribe  →  "command" event
 * ```
 */

const PRE_ROLL_SECONDS = 1.5;

/**
 * How much retained audio to prepend, per trigger kind.
 *
 * The wake value is deliberately generous. The keyword spotter cannot report a
 * hit until it has seen trailing blank frames *after* the phrase, so detection
 * lands several hundred milliseconds late — and people run the wake word
 * straight into the command ("hey jeff open safari") with no pause. With only
 * 150 ms of lead-in the onset of the command was being eaten: "open safari"
 * came back from the recogniser as "Oh, Safari."
 *
 * Reaching back far enough re-includes part of the wake phrase itself, which is
 * fine — `stripWakePhrase` removes it from the transcript afterwards.
 */
const PRE_ROLL_MS = {
  wake: 700,
  /** The user may already be mid-sentence when they hit the key. */
  hotkey: 900,
} as const;

/** Trailing silence that ends an utterance. */
const ENDPOINT_SILENCE_MS = 700;
/** Utterances shorter than this are coughs and clicks, not commands. */
const MIN_SPEECH_MS = 250;
/** A command that runs this long is a stuck mic, not a sentence. */
const MAX_CAPTURE_MS = 12000;
/** Give up if the trigger produced no speech at all — a false wake. */
const NO_SPEECH_TIMEOUT_MS = 3000;

export type TriggerKind = keyof typeof PRE_ROLL_MS;

/**
 * Everything the loop needs from the outside world.
 *
 * These are injected rather than imported so the pipeline can be tested without
 * Electron, the sherpa-onnx native addon, or a microphone — the state machine is
 * where the subtle bugs live, and it deserves fast, hermetic coverage.
 */
export interface VadLike {
  start(): boolean;
  accept(samples: Float32Array): unknown;
  readonly speaking: boolean;
  reset(): void;
}

export interface WakeLike {
  readonly available: boolean;
  readonly unsupportedPhrases: string[];
  start(): boolean;
  accept(samples: Float32Array): { phrase: string } | null;
  reset(): void;
  suppress(): void;
  stop(): void;
}

export interface PipelineDeps {
  speech: SpeechEngine;
  vad: VadLike;
  /** Built lazily so the wake phrase can change without rebuilding the pipeline. */
  makeWake: (phrases: string[], threshold: number) => WakeLike | null;
  /**
   * True while the app's own earcons could still be reaching the microphone.
   * Electron's echo cancellation does not work, so this gate is the only thing
   * stopping the agent from hearing itself.
   */
  isSelfAudioActive: () => boolean;
}

export interface CommandAudio {
  transcript: string;
  /** Before the wake phrase was stripped. Kept for tuning the pre-roll. */
  raw: string;
  trigger: TriggerKind;
  /** Milliseconds from endpoint to transcript. */
  transcribeMs: number;
  /** Seconds of audio transcribed. */
  durationSec: number;
}

type Mode = "off" | "armed" | "capturing";

export declare interface AudioPipeline {
  on(event: "command", fn: (c: CommandAudio) => void): this;
  on(event: "trigger", fn: (kind: TriggerKind) => void): this;
  on(event: "endpoint", fn: () => void): this;
  on(event: "cancelled", fn: (reason: string) => void): this;
  on(event: "level", fn: (level: number) => void): this;
  on(event: "error", fn: (err: Error) => void): this;
}

export class AudioPipeline extends EventEmitter {
  private mode: Mode = "off";
  private readonly ring = new RingBuffer(SAMPLE_RATE * PRE_ROLL_SECONDS);
  private readonly vad: VadLike;
  private wake: WakeLike | null = null;

  private capture: Float32Array[] = [];
  private capturedSamples = 0;
  private captureStartedAt = 0;
  private lastSpeechAt = 0;
  private sawSpeech = false;
  private trigger: TriggerKind = "hotkey";

  // Written out rather than declared as TypeScript parameter properties: those
  // emit code, so Node's type-stripping test runner rejects them.
  private readonly deps: PipelineDeps;
  private settings: AppSettings;

  constructor(deps: PipelineDeps, settings: AppSettings) {
    super();
    this.deps = deps;
    this.settings = settings;
    this.vad = deps.vad;
  }

  get listening(): boolean {
    return this.mode !== "off";
  }

  get wakeAvailable(): boolean {
    return this.wake?.available ?? false;
  }

  get unsupportedWakePhrases(): string[] {
    return this.wake?.unsupportedPhrases ?? [];
  }

  arm(): void {
    this.vad.start();
    if (this.settings.wakeWordEnabled) this.startWake();
    this.mode = "armed";
  }

  disarm(): void {
    this.mode = "off";
    this.resetCapture();
    this.vad.reset();
    this.wake?.stop();
    this.wake = null;
    this.ring.clear();
  }

  updateSettings(next: AppSettings): void {
    const wakeChanged =
      next.wakeWordEnabled !== this.settings.wakeWordEnabled ||
      next.wakeThreshold !== this.settings.wakeThreshold ||
      next.wakeWords.join("|") !== this.settings.wakeWords.join("|");
    this.settings = next;
    if (!wakeChanged || this.mode === "off") return;
    this.wake?.stop();
    this.wake = null;
    if (next.wakeWordEnabled) this.startWake();
  }

  private startWake(): void {
    // Settings exposes "sensitivity" where higher = stricter, which maps
    // directly onto the spotter's activation threshold.
    const wake = this.deps.makeWake(this.settings.wakeWords, this.settings.wakeThreshold * 0.5);
    this.wake = wake && wake.start() ? wake : null;
  }

  /** Called for every block arriving from the capture renderer. */
  acceptFrames(pcm: Int16Array, level: number): void {
    if (this.mode === "off") return;
    const samples = int16ToFloat32(pcm);
    this.ring.push(samples);
    this.emit("level", level);

    // Half-duplex gating. Electron's echo cancellation is confirmed
    // non-functional, so the only reliable way not to hear our own earcons is to
    // drop frames while one is playing, plus a tail for room reverb.
    if (this.deps.isSelfAudioActive()) {
      this.wake?.suppress();
      return;
    }

    this.vad.accept(samples);
    const speaking = this.vad.speaking;
    if (speaking) this.lastSpeechAt = Date.now();

    if (this.mode === "armed") {
      this.detectWake(samples, speaking);
      return;
    }
    this.accumulate(samples, speaking);
  }

  private detectWake(samples: Float32Array, speaking: boolean): void {
    if (!this.wake) return;
    const hit = this.wake.accept(samples);
    if (!hit) return;
    // Two-factor: the keyword score fired AND the VAD agrees someone is
    // actually speaking. The spotter alone is the noisier of the two signals.
    if (!speaking && !this.recentSpeech(400)) return;
    this.begin("wake");
  }

  private recentSpeech(withinMs: number): boolean {
    return this.lastSpeechAt > 0 && Date.now() - this.lastSpeechAt < withinMs;
  }

  /** Start capturing a command. Safe to call from a hotkey at any time. */
  begin(trigger: TriggerKind): void {
    if (this.mode === "off" || this.mode === "capturing") return;
    this.trigger = trigger;
    this.mode = "capturing";
    this.capture = [];
    this.capturedSamples = 0;
    this.captureStartedAt = Date.now();
    this.lastSpeechAt = 0;
    this.sawSpeech = false;

    // Prepend retained audio so the start of the command is never clipped.
    const preRoll = this.ring.tail(Math.round((PRE_ROLL_MS[trigger] / 1000) * SAMPLE_RATE));
    if (preRoll.length) {
      this.capture.push(preRoll);
      this.capturedSamples += preRoll.length;
    }
    this.emit("trigger", trigger);
  }

  private accumulate(samples: Float32Array, speaking: boolean): void {
    this.capture.push(samples);
    this.capturedSamples += samples.length;
    if (speaking) this.sawSpeech = true;

    const elapsed = Date.now() - this.captureStartedAt;

    if (elapsed > MAX_CAPTURE_MS) {
      void this.finish("max duration reached");
      return;
    }
    if (!this.sawSpeech) {
      if (elapsed > NO_SPEECH_TIMEOUT_MS) this.cancel("no speech");
      return;
    }
    // Endpoint: speech happened, and it has been quiet long enough since.
    if (!speaking && this.lastSpeechAt > 0 && Date.now() - this.lastSpeechAt > ENDPOINT_SILENCE_MS) {
      void this.finish();
    }
  }

  /** End a capture early — the hotkey pressed a second time. */
  stopCapture(): void {
    if (this.mode !== "capturing") return;
    if (!this.sawSpeech) {
      this.cancel("no speech");
      return;
    }
    void this.finish();
  }

  private cancel(reason: string): void {
    this.resetCapture();
    this.mode = "armed";
    this.vad.reset();
    this.wake?.reset();
    this.emit("cancelled", reason);
  }

  private async finish(_reason?: string): Promise<void> {
    const audio = this.joinCapture();
    this.resetCapture();
    this.mode = "armed";
    this.vad.reset();
    this.wake?.reset();
    this.emit("endpoint");

    const durationSec = audio.length / SAMPLE_RATE;
    if (durationSec * 1000 < MIN_SPEECH_MS) {
      this.emit("cancelled", "too short");
      return;
    }

    const started = Date.now();
    try {
      const raw = await this.deps.speech.transcribe(audio);
      const transcribeMs = Date.now() - started;
      const transcript =
        this.trigger === "wake" ? stripWakePhrase(raw, this.settings.wakeWords) : raw;
      if (!transcript) {
        this.emit("cancelled", "nothing recognised");
        return;
      }
      this.emit("command", { transcript, raw, trigger: this.trigger, transcribeMs, durationSec });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private joinCapture(): Float32Array {
    const out = new Float32Array(this.capturedSamples);
    let o = 0;
    for (const chunk of this.capture) {
      out.set(chunk, o);
      o += chunk.length;
    }
    return out;
  }

  private resetCapture(): void {
    this.capture = [];
    this.capturedSamples = 0;
    this.sawSpeech = false;
  }
}

/**
 * Remove the wake phrase from the front of a transcript.
 *
 * Pre-roll deliberately reaches back past the trigger, so the recogniser
 * usually hears "hey jeff open safari". The router must only see "open safari".
 *
 * Matching is fuzzy on purpose: the phrase sits at the very edge of the audio
 * and comes back clipped or misheard in predictable ways ("hey jeff" as "hey
 * jef", "a jeff", or just "jeff").
 */
export function stripWakePhrase(transcript: string, wakeWords: string[]): string {
  let text = transcript.trim();
  if (!text) return "";

  // Longest first, so "hey jeff" wins over the bare "jeff" fallback.
  const candidates = [...new Set(wakeWords.flatMap(expandWakeVariants))].sort(
    (a, b) => b.length - a.length,
  );

  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  for (const phrase of candidates) {
    const head = normalized(text);
    const target = normalized(phrase);
    if (!target) continue;
    if (head === target) return "";
    if (head.startsWith(`${target} `)) {
      // Cut the same number of words off the ORIGINAL text, preserving its casing.
      const words = text.split(/\s+/);
      const drop = target.split(" ").length;
      text = words.slice(drop).join(" ").replace(/^[\s,.:;!?-]+/, "");
      return text.trim();
    }
  }
  return text;
}

/** "hey jeff" also arrives as "hey jef", "a jeff", or a bare "jeff". */
function expandWakeVariants(phrase: string): string[] {
  const words = phrase.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = [phrase.toLowerCase()];
  const last = words[words.length - 1]!;
  if (words.length > 1) {
    out.push(last);                       // just the name
    out.push(["a", ...words.slice(1)].join(" "));   // "hey" misheard as "a"
    out.push(["hey", ...words.slice(1)].join(" "));
  }
  // Common clipped spelling: a doubled final consonant loses one.
  if (/(.)\1$/.test(last)) {
    out.push(words.slice(0, -1).concat(last.slice(0, -1)).join(" "));
  }
  return out;
}
