import { EventEmitter } from "node:events";
import type { AppSettings } from "../../shared/types.ts";
import { AutoGain, normalizeUtterance } from "./gain.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { repairAppNames } from "./name-repair.ts";
import { matchWake } from "./wake-match.ts";
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
  /**
   * Speech heard while armed, not yet known to be for us.
   *
   * Generous, because this reaches back over the wake phrase the user has
   * already started saying.
   */
  speech: 900,
  wake: 700,
  /** The user may already be mid-sentence when they hit the key. */
  hotkey: 900,
  /**
   * A follow-up in an open conversation: no wake phrase to reach back past, but
   * the VAD reports speech a beat after it actually starts, so still generous.
   */
  followup: 700,
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

/** Diagnostics hook. Nothing is inferred from silence in the log. */
export type PipelineTrace = (event: string, data?: Record<string, unknown>) => void;

export interface PipelineDeps {
  speech: SpeechEngine;
  /** App names to repair mangled proper nouns against. Refreshed as apps change. */
  appNames?: () => string[];
  vad: VadLike;
  /** Built lazily so the wake phrase can change without rebuilding the pipeline. */
  makeWake: (phrases: string[], threshold: number) => WakeLike | null;
  /**
   * True while the app's own earcons could still be reaching the microphone.
   * Electron's echo cancellation does not work, so this gate is the only thing
   * stopping the agent from hearing itself.
   */
  isSelfAudioActive: () => boolean;
  /** Optional structured trace; defaults to a no-op. */
  trace?: PipelineTrace;
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
  on(event: "followUpEnded", fn: (reason: string) => void): this;
  /** The wake phrase was heard with no command after it. */
  on(event: "prompt", fn: () => void): this;
  on(event: "trigger", fn: (kind: TriggerKind) => void): this;
  on(event: "endpoint", fn: () => void): this;
  on(event: "cancelled", fn: (reason: string) => void): this;
  on(event: "level", fn: (level: number) => void): this;
  on(event: "error", fn: (err: Error) => void): this;
}

export class AudioPipeline extends EventEmitter {
  private mode: Mode = "off";
  private readonly ring = new RingBuffer(SAMPLE_RATE * PRE_ROLL_SECONDS);
  /**
   * Gain for the keyword spotter only.
   *
   * The VAD gets the untouched signal — it is probabilistic and behaves better
   * on natural levels, and the whole point of the two-factor rule is that the
   * two detectors are looking at the audio independently.
   */
  private readonly wakeGain = new AutoGain();
  private readonly vad: VadLike;
  private wake: WakeLike | null = null;

  /**
   * While this is in the future, speech alone starts a capture — no wake word.
   *
   * This is what makes a conversation possible: say "Hey Jeff" once, then keep
   * giving commands until you dismiss it or it times out. It is also what makes
   * confirmations usable at all, since otherwise answering "yes" to "empty the
   * Trash?" would require saying the wake word again first.
   */
  private followUpUntil = 0;

  private capture: Float32Array[] = [];
  private capturedSamples = 0;
  private captureStartedAt = 0;
  private lastSpeechAt = 0;
  private sawSpeech = false;
  private trigger: TriggerKind = "hotkey";
  /**
   * True once we know this capture is meant for us — the keyword spotter fired,
   * the hotkey was pressed, or a conversation was already open. When false the
   * transcript has to prove it by opening with the wake phrase.
   */
  private addressed = false;

  // Written out rather than declared as TypeScript parameter properties: those
  // emit code, so Node's type-stripping test runner rejects them.
  private readonly deps: PipelineDeps;
  private settings: AppSettings;
  private readonly trace: PipelineTrace;
  private wasSpeaking = false;

  constructor(deps: PipelineDeps, settings: AppSettings) {
    super();
    this.deps = deps;
    this.settings = settings;
    this.vad = deps.vad;
    this.trace = deps.trace ?? (() => {});
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

  /** Keep listening for another command without the wake word. */
  openFollowUp(windowMs: number): void {
    this.followUpUntil = Date.now() + windowMs;
    this.trace("follow-up-open", { windowMs });
  }

  closeFollowUp(reason: string): void {
    if (!this.followUpUntil) return;
    this.followUpUntil = 0;
    this.trace("follow-up-close", { reason });
  }

  get inFollowUp(): boolean {
    return Date.now() < this.followUpUntil;
  }

  arm(): void {
    this.vad.start();
    if (this.settings.wakeWordEnabled) this.startWake();
    this.mode = "armed";
  }

  disarm(): void {
    this.mode = "off";
    this.followUpUntil = 0;
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
      this.wakeGain.reset();
      return;
    }

    this.vad.accept(samples);
    const speaking = this.vad.speaking;
    if (speaking) this.lastSpeechAt = Date.now();
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.trace("vad", { speaking, gain: Number(this.wakeGain.value.toFixed(1)) });
    }

    if (this.mode === "armed") {
      // An open conversation lapses on its own, so the agent can stand down and
      // the HUD can stop claiming to be listening.
      if (this.followUpUntil && Date.now() >= this.followUpUntil) {
        this.followUpUntil = 0;
        this.trace("follow-up-close", { reason: "timeout" });
        this.emit("followUpEnded", "timeout");
      }
      // In a conversation, speech alone is enough and is known to be for us.
      if (this.inFollowUp && speaking) {
        this.begin("followup");
        return;
      }
      // Otherwise, start capturing on ANY speech — speculatively, with no
      // earcon and no overlay, because we do not yet know it was meant for us.
      //
      // The keyword spotter used to be the only way in, and it was not reliable
      // enough: the same phrase at ordinary speaking volume was missed at every
      // threshold. The transcript decides instead, and the spotter is kept only
      // as a fast path that lights the overlay early when it does fire.
      // Gated on the wake word being enabled at all. With it off, the agent
      // must not be transcribing every utterance in the room — only what the
      // hotkey explicitly captures.
      if (speaking && this.settings.wakeWordEnabled) {
        this.begin("speech");
        return;
      }
      this.detectWake(samples, speaking);
      return;
    }
    // Keep the spotter running during a speculative capture, so it can still
    // promote it mid-sentence.
    if (this.trigger === "speech" && !this.addressed) this.detectWake(samples, speaking);
    this.accumulate(samples, speaking);
  }

  /**
   * Optional fast path.
   *
   * When the spotter does fire it is worth acting on immediately: the user gets
   * the "listening" cue while they are still speaking. When it does not, the
   * transcript check at the end of the utterance covers it.
   */
  private detectWake(samples: Float32Array, speaking: boolean): void {
    if (!this.wake) return;
    // Gained, because the spotter is strongly level-dependent: the same phrase
    // at a normal speaking level is missed at every threshold without this.
    const gained = this.wakeGain.process(samples);
    const hit = this.wake.accept(gained);
    if (!hit) return;
    // Two-factor: the keyword score fired AND the VAD agrees someone is
    // actually speaking. The spotter alone is the noisier of the two signals.
    const corroborated = speaking || this.recentSpeech(400);
    this.trace("wake-hit", { phrase: hit.phrase, speaking, corroborated,
                             gain: Number(this.wakeGain.value.toFixed(1)) });
    if (!corroborated) return;
    if (this.mode === "capturing") {
      // Already capturing speculatively: promote it, and let the user know.
      if (!this.addressed) {
        this.addressed = true;
        this.trigger = "wake";
        this.emit("trigger", "wake");
      }
      return;
    }
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
    this.addressed = trigger !== "speech";
    // A speculative capture announces nothing: an earcon every time anyone in
    // the room speaks would be intolerable.
    if (this.addressed) this.emit("trigger", trigger);
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
      // Normalise the whole utterance at once. Unlike the streaming gain this
      // can see the true peak, so it needs no smoothing and cannot pump.
      const heard = await this.deps.speech.transcribe(normalizeUtterance(audio));

      // Repair mangled app names before anything looks at the text. Recognisers
      // fail on proper nouns specifically, and this machine knows which ones
      // exist — "clawed" becomes "Claude" here rather than confusing the router.
      const repaired = repairAppNames(heard, this.deps.appNames?.() ?? []);
      if (repaired.repairs.length) this.trace("repaired", { repairs: repaired.repairs });
      const raw = repaired.text;
      const transcribeMs = Date.now() - started;
      if (!raw) {
        this.emit("cancelled", "nothing recognised");
        return;
      }

      let transcript: string;
      if (this.addressed) {
        // Known to be for us. The pre-roll may still have caught the wake
        // phrase, so take it off if it is there.
        transcript = stripWakePhrase(raw, this.settings.wakeWords);
      } else {
        // Speculative: it only counts if it opens with the wake phrase.
        const hit = matchWake(raw, this.settings.wakeWords);
        this.trace("wake-match", { matched: hit.matched, phrase: hit.phrase, raw });
        if (!hit.matched) {
          this.emit("cancelled", "not addressed");
          return;
        }
        if (!hit.rest) {
          // Just the wake phrase: acknowledge and wait for the actual command.
          this.emit("prompt");
          return;
        }
        transcript = hit.rest;
      }

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
