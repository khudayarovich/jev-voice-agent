import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { KWS_MODEL_DIR, type SherpaKws, type SherpaKwsStream, loadSherpa, modelDir } from "./sherpa.ts";
import { PhraseTokenizer, fromLabel } from "./text2token.ts";
import { SAMPLE_RATE } from "./wav.ts";

/**
 * Wake-word detection, open-vocabulary and training-free.
 *
 * sherpa-onnx's keyword spotter is a small transducer constrained to a keyword
 * list, so **any phrase can be registered at runtime** — no model to train, no
 * per-keyword licence, and the user can change the wake phrase in Settings and
 * have it take effect immediately. That is why this engine was chosen over the
 * alternatives: Picovoice Porcupine discontinued its free tier in June 2026, and
 * openWakeWord's pre-trained models are CC BY-NC-SA with an unresolved licence
 * on the shared embedding backbone.
 *
 * "Hey Jeff" is a genuinely hard wake word — two syllables, ~400 ms, and
 * phonetically close to "hey chef" / "hey Jess". Three defences, all here or in
 * the pipeline:
 *   - a score threshold the user can tune,
 *   - a refractory window after any trigger,
 *   - and the two-factor rule in the pipeline: keyword hit AND concurrent VAD
 *     speech.
 */

export interface WakeOptions {
  phrases: string[];
  /** 0..1. Higher means fewer false accepts and more missed wakes. */
  threshold?: number;
}

export interface WakeResult {
  phrase: string;
}

export class WakeWord {
  private kws: SherpaKws | null = null;
  private stream: SherpaKwsStream | null = null;
  private lastTrigger = 0;
  private skipped: string[] = [];

  /** Ignore further hits for this long after one fires. */
  static readonly REFRACTORY_MS = 1500;

  private opts: WakeOptions;

  constructor(opts: WakeOptions) {
    this.opts = opts;
  }

  get available(): boolean {
    return this.kws !== null;
  }

  /** Phrases the token model could not represent (e.g. non-Latin text). */
  get unsupportedPhrases(): string[] {
    return this.skipped;
  }

  start(): boolean {
    const sherpa = loadSherpa();
    if (!sherpa) return false;

    const dir = modelDir(KWS_MODEL_DIR);
    if (!existsSync(dir)) {
      console.error("[wake] missing KWS model at", dir);
      return false;
    }

    const keywordsFile = this.writeKeywords(dir);
    if (!keywordsFile) return false;

    try {
      this.kws = new sherpa.KeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: path.join(dir, "encoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            decoder: path.join(dir, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            joiner: path.join(dir, "joiner-epoch-12-avg-2-chunk-16-left-64.onnx"),
          },
          tokens: path.join(dir, "tokens.txt"),
          numThreads: 1,
          provider: "cpu",
          debug: false,
        },
        maxActivePaths: 4,
        keywordsFile,
        keywordsScore: 1.0,
        keywordsThreshold: this.opts.threshold ?? 0.25,
        numTrailingBlanks: 1,
      });
      this.stream = this.kws.createStream();
      return true;
    } catch (err) {
      console.error("[wake] failed to start:", err);
      this.kws = null;
      return false;
    }
  }

  /**
   * Compile the user's phrases into a keywords file.
   *
   * Written to userData rather than the app bundle: the bundle is read-only once
   * packaged, and these change whenever the user edits Settings.
   */
  private writeKeywords(modelPath: string): string | null {
    const tokenizer = PhraseTokenizer.fromFile(path.join(modelPath, "bpe.model"));
    const { text, skipped } = tokenizer.buildKeywordsFile(this.opts.phrases);
    this.skipped = skipped;
    if (!text.trim()) {
      console.error("[wake] no usable phrases:", this.opts.phrases);
      return null;
    }
    const out = path.join(app.getPath("userData"), "wake-keywords.txt");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text, "utf8");
    return out;
  }

  /** Feed audio. Returns a result only when a keyword fires outside the refractory window. */
  accept(samples: Float32Array): WakeResult | null {
    if (!this.kws || !this.stream) return null;

    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });

    let hit: WakeResult | null = null;
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const result = this.kws.getResult(this.stream);
      if (!result.keyword) continue;
      // Always reset, even when suppressed, so the decoder does not re-report
      // the same activation on the next chunk.
      this.kws.reset(this.stream);
      const now = Date.now();
      if (now - this.lastTrigger < WakeWord.REFRACTORY_MS) continue;
      this.lastTrigger = now;
      hit = { phrase: fromLabel(result.keyword) };
    }
    return hit;
  }

  /** Drop decoder state, e.g. after the app played audio into its own mic. */
  reset(): void {
    if (!this.kws) return;
    this.stream = this.kws.createStream();
  }

  /** Suppress triggers for the refractory window, without reporting one. */
  suppress(): void {
    this.lastTrigger = Date.now();
  }

  update(opts: WakeOptions): boolean {
    this.stop();
    this.opts = opts;
    return this.start();
  }

  stop(): void {
    this.kws = null;
    this.stream = null;
  }
}
