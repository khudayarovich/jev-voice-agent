import { EventEmitter } from "node:events";
import type { AppSettings } from "../../shared/types.ts";
import { isIncomplete } from "../actions/realtime.ts";
import { AutoGain, normalizeUtterance } from "./gain.ts";
import { repairAppNames } from "./name-repair.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { matchWake, wakeVerdict } from "./wake-match.ts";
import { SAMPLE_RATE, int16ToFloat32 } from "./wav.ts";
import type { SpeechEngine } from "./whisper.ts";

/**
 * The listening loop — streaming.
 *
 * ```
 * frames → ring buffer (1.5 s pre-roll)
 *        → [armed]      speech, the wake word, the hotkey, or an open
 *                       conversation starts a capture
 *        → [capturing]  while the user speaks: transcribe what we have so far
 *                         (partials — live text, early wake detection, and
 *                         finished clauses of a chain)
 *                       the moment they pause: transcribe all of it and hand it
 *                         over as a TENTATIVE utterance the agent may act on
 *                         at once
 *                       after a longer silence: the utterance is final
 * ```
 *
 * The old loop waited ~1.4 s of silence, then transcribed, then routed. Here
 * the transcription starts ~0.2 s after the user stops, the routing starts as
 * soon as it lands, and a complete command runs without waiting for the
 * silence to be "long enough" at all.
 *
 * Time is counted in samples, not wall-clock: the loop advances exactly as
 * audio arrives, which makes it deterministic to test.
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

/**
 * Silence that ends a complete-sounding utterance, counted after the VAD's own
 * ~0.2 s hangover. Most commands never wait for it: they are acted on as soon
 * as the pause is transcribed and routed.
 */
const ENDPOINT_SILENCE_MS = 500;
/**
 * …and one that sounds unfinished: "set the volume to", "open my", or just
 * "Hey Jeff" on its own. A pause there is the user thinking.
 */
const HESITATION_SILENCE_MS = 1300;
/** Longest to wait on a pause's transcription before ending anyway. */
const TRANSCRIPTION_WAIT_MS = 3000;
/** Utterances shorter than this are coughs and clicks, not commands. */
const MIN_SPEECH_MS = 250;
/** A command that runs this long is a stuck mic, not a sentence. */
const MAX_CAPTURE_MS = 12000;
/** Give up if the trigger produced no speech at all — a false wake. */
const NO_SPEECH_TIMEOUT_MS = 3000;

/**
 * Transcribe while the user is speaking only if the engine can keep up: at
 * ~150 ms a pass (small.en here) a partial every ~0.6 s costs a quarter of the
 * GPU; at ~600 ms (large-v3-turbo) it would hold the engine exactly when the
 * pause's transcription needs it, and make the answer slower, not faster.
 */
const STREAM_MAX_ENGINE_MS = 350;
/** First partial once "hey jeff" can have been said… */
const FIRST_PARTIAL_MS = 700;
/** …then no more often than this. */
const PARTIAL_EVERY_MS = 600;
/** Keep an open conversation from lapsing while the agent acts on what it heard. */
const FOLLOW_UP_HOLD_MS = 10_000;

/**
 * How long the VAD keeps reporting speech after it stops. Short, because the
 * silence rules below do the real endpointing; the old 0.7 s here was counted
 * on top of a 0.7 s endpoint, so every command waited 1.4 s of dead air.
 */
export const VAD_HANGOVER_MS = 200;

const samplesOf = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
const msOf = (samples: number) => (samples / SAMPLE_RATE) * 1000;

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

/** How a tentative utterance turned out. */
export type Settlement = "final" | "resumed" | "dropped";

/** What the user said, handed to the agent. */
export interface Utterance {
  captureId: number;
  /** The command, with any wake phrase taken off. */
  transcript: string;
  /** Before the wake phrase was stripped. Kept for tuning the pre-roll. */
  raw: string;
  trigger: TriggerKind;
  /** Milliseconds from the start of transcription to the transcript. */
  transcribeMs: number;
  /** Seconds of audio transcribed. */
  durationSec: number;
  /** Wall-clock estimate of when the user stopped speaking. */
  speechEndedAt: number;
  /**
   * False when the user has only paused: they may yet go on. The agent may act
   * on it anyway by calling `commit()`, or wait for `settled`.
   */
  final: boolean;
  /** Resolves once it is known whether the user went on speaking. */
  settled: Promise<Settlement>;
  /**
   * Claim this utterance now and end the capture here. Returns false if the
   * user has already started speaking again, in which case a longer utterance
   * is on its way.
   */
  commit(): boolean;
}

type PassKind = "partial" | "tentative" | "final";
const PRIORITY: Record<PassKind, number> = { partial: 0, tentative: 1, final: 2 };

interface Heard {
  transcript: string;
  raw: string;
  epoch: number;
  transcribeMs: number;
  durationSec: number;
}

interface Capture {
  id: number;
  trigger: TriggerKind;
  addressed: boolean;
  /** Addressed because the transcript opened with the wake phrase. */
  wokeByTranscript: boolean;
  chunks: Float32Array[];
  /** Samples captured, pre-roll included; also this capture's clock. */
  length: number;
  preRoll: number;
  sawSpeech: boolean;
  speaking: boolean;
  lastSpeechAt: number;
  /** Wall-clock time of the last block the VAD called speech. */
  lastSpeechWall: number;
  /** Bumps whenever speech starts again after a pause. */
  epoch: number;
  /** The epoch the latest pause-transcription was asked for, and whether it failed. */
  tentativeEpoch: number;
  tentativeFailed: boolean;
  lastPartialAt: number;
  /** The latest transcription of a complete stretch of speech. */
  heard: Heard | null;
  /** The tentative utterance the agent holds, until it settles. */
  pending: { epoch: number; settle: (how: Settlement) => void; how: Settlement | null } | null;
  /** The user has been told "go ahead" after saying only the wake phrase. */
  prompted: boolean;
  /** No more audio: the silence ran out, or the agent committed. */
  ended: boolean;
  /** Nothing more will be emitted for it. */
  closed: boolean;
}

interface Pass {
  c: Capture;
  kind: PassKind;
  epoch: number;
  abort: AbortController;
  started: number;
}

type Mode = "off" | "armed" | "capturing";

export declare interface AudioPipeline {
  /** A capture began — not necessarily one meant for us. */
  on(event: "capture", fn: (info: { id: number; trigger: TriggerKind; addressed: boolean }) => void): this;
  /** It is known to be meant for us: wake word, hotkey, or an open conversation. */
  on(event: "trigger", fn: (kind: TriggerKind) => void): this;
  /** Live text while the user is still speaking. */
  on(event: "partial", fn: (p: { captureId: number; transcript: string }) => void): this;
  /** The user paused; a transcription of everything so far is under way. */
  on(event: "pause", fn: (p: { captureId: number }) => void): this;
  on(event: "utterance", fn: (u: Utterance) => void): this;
  /** The silence ran out on a capture meant for us. */
  on(event: "endpoint", fn: () => void): this;
  /** The wake phrase was heard with no command after it. */
  on(event: "prompt", fn: () => void): this;
  on(event: "cancelled", fn: (reason: string) => void): this;
  on(event: "followUpEnded", fn: (reason: string) => void): this;
  on(event: "level", fn: (level: number) => void): this;
  on(event: "error", fn: (err: Error) => void): this;
}

export class AudioPipeline extends EventEmitter {
  private mode: Mode = "off";
  private readonly ring = new RingBuffer(SAMPLE_RATE * PRE_ROLL_SECONDS);
  /** Samples received since the pipeline was built: the global clock. */
  private clock = 0;
  /** Audio before this point belongs to a command already handled. */
  private consumedAt = 0;
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

  private capture: Capture | null = null;
  private captureSeq = 0;
  private pass: Pass | null = null;
  private queue: { c: Capture; kind: PassKind }[] = [];
  /**
   * Someone else's conversation was just rejected: do not start another
   * speculative capture until they stop, or every sentence of it would be
   * transcribed a second at a time.
   */
  private cooldown = false;
  private lastSpeechClock = 0;
  private wasSpeaking = false;

  // Written out rather than declared as TypeScript parameter properties: those
  // emit code, so Node's type-stripping test runner rejects them.
  private readonly deps: PipelineDeps;
  private settings: AppSettings;
  private readonly trace: PipelineTrace;

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

  /** Transcribing while the user speaks: on, and the engine fast enough. */
  get streaming(): boolean {
    return this.settings.realtime !== false && (this.deps.speech.typicalMs ?? 0) <= STREAM_MAX_ENGINE_MS;
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
    const c = this.capture;
    this.capture = null;
    if (c) this.close(c, "dropped");
    this.pass?.abort.abort();
    this.queue = [];
    this.cooldown = false;
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
    this.clock += samples.length;
    this.emit("level", level);

    const c = this.capture;
    // Half-duplex gating. Electron's echo cancellation is confirmed
    // non-functional, so while one of our own cues could be reaching the mic
    // nothing may START because of it. A capture already running keeps every
    // frame, though: dropping them used to cut ~300 ms out of the middle of the
    // user's command whenever a cue played over it.
    const selfAudio = this.deps.isSelfAudioActive();
    if (selfAudio) {
      this.wake?.suppress();
      this.wakeGain.reset();
      if (!c) return;
    }

    this.vad.accept(samples);
    const speaking = this.vad.speaking;
    if (speaking) this.lastSpeechClock = this.clock;
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.trace("vad", { speaking, gain: Number(this.wakeGain.value.toFixed(1)) });
    }

    if (!c) {
      // An open conversation lapses on its own, so the agent can stand down and
      // the HUD can stop claiming to be listening.
      if (this.followUpUntil && Date.now() >= this.followUpUntil) {
        this.followUpUntil = 0;
        this.trace("follow-up-close", { reason: "timeout" });
        this.emit("followUpEnded", "timeout");
      }
      if (this.cooldown && !speaking) this.cooldown = false;
      // In a conversation, speech alone is enough and is known to be for us.
      if (this.inFollowUp && speaking) {
        this.begin("followup");
        return;
      }
      // Otherwise, start capturing on ANY speech — speculatively, with no
      // earcon and no overlay, because we do not yet know it was meant for us.
      // The transcript decides, and the spotter is kept as a fast path that
      // lights the overlay early when it does fire.
      //
      // Gated on the wake word being enabled at all. With it off, the agent
      // must not be transcribing every utterance in the room — only what the
      // hotkey explicitly captures.
      if (speaking && this.settings.wakeWordEnabled && !this.cooldown) {
        this.begin("speech");
        return;
      }
      this.detectWake(samples, speaking);
      return;
    }

    // Keep the spotter running during a speculative capture, so it can still
    // promote it mid-sentence.
    if (!c.addressed && !selfAudio) this.detectWake(samples, speaking);
    this.accumulate(c, samples, speaking);
  }

  /**
   * Optional fast path.
   *
   * When the spotter does fire it is worth acting on immediately: the user gets
   * the "listening" cue while they are still speaking. When it does not, the
   * transcript covers it.
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
    const corroborated =
      speaking || (this.lastSpeechClock > 0 && this.clock - this.lastSpeechClock < samplesOf(400));
    this.trace("wake-hit", { phrase: hit.phrase, speaking, corroborated,
                             gain: Number(this.wakeGain.value.toFixed(1)) });
    if (!corroborated) return;
    this.cooldown = false;
    this.begin("wake");
  }

  /**
   * Start capturing a command. Safe to call from a hotkey at any time: if a
   * speculative capture is already running, it is promoted instead — pressing
   * the key a moment after starting to speak is exactly when it is needed.
   */
  begin(trigger: TriggerKind): void {
    if (this.mode === "off") return;
    const running = this.capture;
    if (running) {
      if (!running.addressed && trigger !== "speech") {
        running.addressed = true;
        running.trigger = trigger;
        this.trace("promoted", { capture: running.id, trigger });
        this.emit("trigger", trigger);
      }
      return;
    }

    // Never reach back into audio that belonged to the previous command: the
    // tail of "open Safari" must not reappear at the start of what comes next.
    const available = Math.max(0, this.clock - this.consumedAt);
    const pre = this.ring.tail(Math.min(samplesOf(PRE_ROLL_MS[trigger]), available));
    const c: Capture = {
      id: ++this.captureSeq,
      trigger,
      addressed: trigger !== "speech",
      wokeByTranscript: false,
      chunks: pre.length ? [pre] : [],
      length: pre.length,
      preRoll: pre.length,
      sawSpeech: false,
      speaking: false,
      lastSpeechAt: 0,
      lastSpeechWall: 0,
      epoch: 0,
      tentativeEpoch: -1,
      tentativeFailed: false,
      lastPartialAt: 0,
      heard: null,
      pending: null,
      prompted: false,
      ended: false,
      closed: false,
    };
    this.capture = c;
    this.mode = "capturing";
    this.trace("capture", { capture: c.id, trigger, preRollMs: Math.round(msOf(pre.length)) });
    this.emit("capture", { id: c.id, trigger, addressed: c.addressed });
    // A speculative capture announces nothing: an earcon every time anyone in
    // the room speaks would be intolerable.
    if (c.addressed) this.emit("trigger", trigger);
  }

  private accumulate(c: Capture, samples: Float32Array, speaking: boolean): void {
    c.chunks.push(samples);
    c.length += samples.length;

    if (speaking) {
      if (!c.speaking) {
        c.speaking = true;
        c.epoch++;
        if (c.epoch > 1) this.resumed(c);
      }
      c.sawSpeech = true;
      c.lastSpeechAt = c.length;
      c.lastSpeechWall = Date.now();
    } else if (c.speaking) {
      c.speaking = false;
      this.paused(c);
    }

    const elapsed = msOf(c.length - c.preRoll);
    if (elapsed > MAX_CAPTURE_MS) {
      this.end(c, "max duration");
      return;
    }
    if (!c.sawSpeech) {
      if (elapsed > NO_SPEECH_TIMEOUT_MS) this.drop(c, "no speech");
      return;
    }
    if (c.speaking) {
      this.maybePartial(c);
      return;
    }
    if (msOf(c.length - c.lastSpeechAt) >= this.silenceNeeded(c)) this.end(c, "silence");
  }

  /** The user stopped: transcribe everything now, while they may be done. */
  private paused(c: Capture): void {
    this.request(c, "tentative");
    if (c.addressed) this.emit("pause", { captureId: c.id });
  }

  /** The user started again after a pause. */
  private resumed(c: Capture): void {
    if (c.pending && !c.pending.how) {
      this.trace("resumed", { capture: c.id });
      this.settlePending(c, "resumed");
    }
    // A transcription of the pause is worthless now: free the engine.
    if (this.pass?.c === c && this.pass.kind === "tentative") this.pass.abort.abort();
  }

  /** How much silence ends this utterance, judged by what it says so far. */
  private silenceNeeded(c: Capture): number {
    if (c.heard && c.heard.epoch === c.epoch) {
      const text = c.addressed ? c.heard.transcript : "";
      return isIncomplete(text) ? HESITATION_SILENCE_MS : ENDPOINT_SILENCE_MS;
    }
    // The pause's transcription is on its way, and how long to wait depends on
    // what it says — "open Safari" is done, "open the" is not.
    if (c.tentativeEpoch === c.epoch && !c.tentativeFailed) return TRANSCRIPTION_WAIT_MS;
    return ENDPOINT_SILENCE_MS;
  }

  private maybePartial(c: Capture): void {
    if (!this.streaming || this.pass || c.ended) return;
    const typical = this.deps.speech.typicalMs ?? 0;
    const due = c.lastPartialAt === 0
      ? c.preRoll + samplesOf(FIRST_PARTIAL_MS)
      : c.lastPartialAt + samplesOf(Math.max(PARTIAL_EVERY_MS, typical * 2));
    if (c.length >= due) this.request(c, "partial");
  }

  /** End a capture early — the hotkey pressed a second time. */
  stopCapture(): void {
    const c = this.capture;
    if (!c) return;
    if (!c.sawSpeech) {
      this.drop(c, "no speech");
      return;
    }
    this.end(c, "stopped");
  }

  // -------------------------------------------------------------------------
  // Ending a capture
  // -------------------------------------------------------------------------

  /** Stop taking audio for this capture. */
  private release(c: Capture): void {
    c.ended = true;
    if (this.capture !== c) return;
    this.capture = null;
    this.mode = "armed";
    this.wake?.reset();
  }

  /** The silence ran out (or the hotkey, or the length limit). */
  private end(c: Capture, why: string): void {
    if (c.ended) return;
    this.release(c);
    this.trace("end", { capture: c.id, why, seconds: Number((c.length / SAMPLE_RATE).toFixed(2)) });
    if (c.addressed) {
      this.consumedAt = this.clock;
      this.emit("endpoint");
    }
    if (c.closed) return;

    if (msOf(c.length) < MIN_SPEECH_MS) {
      this.drop(c, "too short");
      return;
    }
    // The agent already holds the transcription of this stretch of speech.
    if (c.pending && c.pending.epoch === c.epoch) {
      this.close(c, "final");
      return;
    }
    if (c.heard && c.heard.epoch === c.epoch) {
      this.deliverFinal(c, c.heard);
      return;
    }
    // Its transcription is still running: that becomes the final one.
    if (this.pass?.c === c && this.pass.kind === "tentative" && this.pass.epoch === c.epoch) return;
    this.request(c, "final");
  }

  /** Give up on a capture: no command in it. */
  private drop(c: Capture, reason: string): void {
    if (c.closed) return;
    this.release(c);
    this.close(c, "dropped");
    this.trace("dropped", { capture: c.id, reason });
    this.emit("cancelled", reason);
  }

  private close(c: Capture, how: Settlement): void {
    c.ended = true;
    c.closed = true;
    this.settlePending(c, how);
    if (this.pass?.c === c && this.pass.kind !== "final") this.pass.abort.abort();
    this.queue = this.queue.filter((q) => q.c !== c);
  }

  private settlePending(c: Capture, how: Settlement): void {
    const p = c.pending;
    if (!p || p.how) return;
    p.how = how;
    p.settle(how);
  }

  /** The agent is acting on a tentative utterance: end the capture here. */
  private commit(c: Capture, epoch: number): boolean {
    if (c.pending?.epoch !== epoch) return false;
    if (c.pending.how) return c.pending.how === "final";
    if (c.epoch !== epoch || c.speaking) return false;
    this.release(c);
    this.consumedAt = this.clock;
    this.trace("committed", { capture: c.id });
    this.close(c, "final");
    return true;
  }

  // -------------------------------------------------------------------------
  // Transcription passes
  // -------------------------------------------------------------------------

  /**
   * Queue a transcription of the capture as it stands.
   *
   * One at a time — the engine is serial anyway — and in order of importance:
   * a final beats a pause's transcription beats a partial, and a partial in
   * flight is abandoned the moment anything more important is waiting.
   */
  private request(c: Capture, kind: PassKind): void {
    if (c.closed) return;
    if (kind === "tentative") {
      c.tentativeEpoch = c.epoch;
      c.tentativeFailed = false;
    }
    const running = this.pass;
    if (!running) {
      this.start(c, kind);
      return;
    }
    if (running.kind === "partial" && kind !== "partial") running.abort.abort();
    this.queue = this.queue.filter((q) => !(q.c === c && PRIORITY[q.kind] <= PRIORITY[kind]));
    if (!this.queue.some((q) => q.c === c && PRIORITY[q.kind] > PRIORITY[kind])) this.queue.push({ c, kind });
  }

  private start(c: Capture, kind: PassKind): void {
    const audio = new Float32Array(c.length);
    let o = 0;
    for (const chunk of c.chunks) {
      audio.set(chunk, o);
      o += chunk.length;
    }
    const pass: Pass = { c, kind, epoch: c.epoch, abort: new AbortController(), started: Date.now() };
    this.pass = pass;
    if (kind === "partial") c.lastPartialAt = c.length;

    // Normalise the whole utterance at once. Unlike the streaming gain this can
    // see the true peak, so it needs no smoothing and cannot pump.
    this.deps.speech
      .transcribe(normalizeUtterance(audio), { signal: pass.abort.signal })
      .then(
        (text) => this.passDone(pass, text, audio.length),
        (err: unknown) => this.passFailed(pass, err),
      )
      .finally(() => {
        if (this.pass === pass) this.pass = null;
        this.pump();
      });
  }

  private pump(): void {
    if (this.pass) return;
    this.queue.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind]);
    while (this.queue.length) {
      const next = this.queue.shift()!;
      const { c, kind } = next;
      if (c.closed) continue;
      if (kind === "partial" && (c.ended || c !== this.capture)) continue;
      if (kind === "tentative" && (c.tentativeEpoch !== c.epoch || c.speaking)) continue;
      this.start(c, kind);
      return;
    }
  }

  private passFailed(pass: Pass, err: unknown): void {
    if (pass.abort.signal.aborted) return; // we abandoned it on purpose
    const { c, kind } = pass;
    const message = err instanceof Error ? err.message : String(err);
    this.trace("pass-failed", { capture: c.id, kind, message });
    if (kind === "partial" || c.closed) return;
    if (kind === "tentative") {
      c.tentativeFailed = true;
      // It was going to be the final one: make a real final instead.
      if (c.ended) this.request(c, "final");
      return;
    }
    this.close(c, "dropped");
    this.emit("error", err instanceof Error ? err : new Error(message));
  }

  private passDone(pass: Pass, text: string, samples: number): void {
    const { c, kind } = pass;
    if (c.closed) return;
    const transcribeMs = Date.now() - pass.started;

    // Repair mangled app names before anything looks at the text. Recognisers
    // fail on proper nouns specifically, and this machine knows which ones
    // exist — "clawed" becomes "Claude" here rather than confusing the router.
    const repaired = repairAppNames(text, this.deps.appNames?.() ?? []);
    if (repaired.repairs.length) this.trace("repaired", { repairs: repaired.repairs });
    const raw = repaired.text;
    this.trace("heard", { capture: c.id, kind, transcribeMs, raw });

    if (!c.addressed) {
      // Speculative: it only counts if it opens with the wake phrase.
      const verdict = wakeVerdict(raw, this.settings.wakeWords);
      this.trace("wake-match", { verdict, raw });
      if (verdict === "yes") {
        c.addressed = true;
        c.wokeByTranscript = true;
        c.trigger = "wake";
        this.emit("trigger", "wake");
      } else if (verdict === "no" || kind === "final" || c.ended) {
        // Someone else's conversation. Stop transcribing it, and do not start
        // again on the rest of their sentence.
        if (!c.ended && c.speaking) this.cooldown = true;
        this.drop(c, "not addressed");
        return;
      } else {
        // Too early to tell. Note that it was heard, so the silence rule knows.
        if (kind !== "partial" && pass.epoch === c.epoch) {
          c.heard = { transcript: "", raw, epoch: pass.epoch, transcribeMs, durationSec: samples / SAMPLE_RATE };
        }
        return;
      }
    }

    const transcript = this.commandText(c, raw);
    if (kind === "partial") {
      if (transcript && !c.ended) this.emit("partial", { captureId: c.id, transcript });
      return;
    }
    // They have spoken since this snapshot: a newer one is coming.
    if (pass.epoch !== c.epoch) return;

    const heard: Heard = { transcript, raw, epoch: pass.epoch, transcribeMs, durationSec: samples / SAMPLE_RATE };
    c.heard = heard;
    if (kind === "final" || c.ended) {
      this.deliverFinal(c, heard);
      return;
    }
    // Just the wake phrase so far, and a pause: say "go ahead" now rather than
    // after the long silence, and keep listening for the rest.
    if (!transcript) {
      if (!c.prompted && matchWake(raw, this.settings.wakeWords).matched) {
        c.prompted = true;
        this.emit("prompt");
      }
      return;
    }
    this.hand(c, heard, false);
  }

  private deliverFinal(c: Capture, heard: Heard): void {
    if (c.closed) return;
    if (!c.addressed) {
      this.drop(c, "not addressed");
      return;
    }
    if (!heard.transcript) {
      const wakeOnly = matchWake(heard.raw, this.settings.wakeWords).matched;
      this.close(c, "dropped");
      // Already told them to go ahead; the conversation is open and waiting.
      if (c.prompted) {
        this.consumedAt = this.clock;
        return;
      }
      if (wakeOnly) {
        // Just the wake phrase: acknowledge and wait for the actual command.
        this.consumedAt = this.clock;
        this.emit("prompt");
      } else {
        this.emit("cancelled", "nothing recognised");
      }
      return;
    }
    this.hand(c, heard, true);
  }

  /** Hand an utterance to the agent. */
  private hand(c: Capture, heard: Heard, final: boolean): void {
    // The agent is about to act: an open conversation must not lapse under it.
    if (this.followUpUntil) this.followUpUntil = Math.max(this.followUpUntil, Date.now() + FOLLOW_UP_HOLD_MS);

    let settle: (how: Settlement) => void = () => {};
    const settled = new Promise<Settlement>((resolve) => {
      settle = resolve;
    });
    if (c.pending && !c.pending.how) this.settlePending(c, "resumed");
    c.pending = { epoch: heard.epoch, settle, how: null };
    if (final) this.close(c, "final");

    this.trace("utterance", { capture: c.id, final, transcript: heard.transcript });
    this.emit("utterance", {
      captureId: c.id,
      transcript: heard.transcript,
      raw: heard.raw,
      trigger: c.trigger,
      transcribeMs: heard.transcribeMs,
      durationSec: heard.durationSec,
      speechEndedAt: c.lastSpeechWall ? c.lastSpeechWall - VAD_HANGOVER_MS : Date.now(),
      final,
      settled,
      commit: () => this.commit(c, heard.epoch),
    } satisfies Utterance);
  }

  /** The command itself: the transcript with any wake phrase taken off. */
  private commandText(c: Capture, raw: string): string {
    if (c.wokeByTranscript) {
      const hit = matchWake(raw, this.settings.wakeWords);
      if (hit.matched) return hit.rest;
    }
    // Known to be for us. The pre-roll may still have caught the wake phrase,
    // so take it off if it is there.
    return stripWakePhrase(raw, this.settings.wakeWords);
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
