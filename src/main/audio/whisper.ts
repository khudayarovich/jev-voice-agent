import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";
import { DEFAULT_MODEL_ID, modelById } from "./models.ts";
import { orphanedServers } from "./orphans.ts";
import { SAMPLE_RATE, encodeWav } from "./wav.ts";

/**
 * Local speech-to-text via whisper.cpp.
 *
 * Runs `whisper-server` as a long-lived child rather than spawning `whisper-cli`
 * per utterance. Measured on an M4 Pro with base.en and Metal, for a 3-second
 * command:
 *
 *   spawn whisper-cli per command   ~150-170 ms   (49 ms model load + ~50 ms spawn)
 *   resident whisper-server          ~72-75 ms    (inference is only ~32 ms)
 *
 * Roughly 100 ms of pure overhead removed from a 600 ms budget, every command.
 *
 * The other reason this class exists is `warmup()`. The very first Metal run on
 * a machine compiles the shader library, which took **17 seconds** here. That
 * must happen at startup, never on the user's first spoken command.
 */

export interface TranscribeOptions {
  /**
   * Abandon the request. whisper-server notices the closed connection and stops
   * decoding, which is what makes speculative passes cheap to throw away when
   * the user turns out to still be talking.
   */
  signal?: AbortSignal;
}

export interface SpeechEngine {
  start(): Promise<void>;
  stop(): void;
  transcribe(samples: Float32Array, opts?: TranscribeOptions): Promise<string>;
  isReady(): boolean;
  /**
   * Typical milliseconds per transcription, measured as it runs. The pipeline
   * uses it to decide how often it can afford to transcribe while the user is
   * still speaking: every ~0.7 s for a 150 ms model, never for a 600 ms one.
   */
  readonly typicalMs?: number;
  /**
   * Words the recogniser should expect.
   *
   * Worth more than model size: seeding the decoder with the app names actually
   * installed on this Mac cut word error rate by more than half, because nearly
   * every failure is a proper noun the model had no reason to consider.
   */
  setVocabulary?(prompt: string): void;
}

export function binaryPath(): string {
  // The installed app carries its own self-contained build in Resources; a
  // development checkout uses the one `npm run setup` built into vendor/.
  return app.isPackaged
    ? path.join(process.resourcesPath, "whisper", "whisper-server")
    : path.join(app.getAppPath(), "vendor", "whisper.cpp", "build", "bin", "whisper-server");
}

/**
 * Kill servers left behind by a run that did not exit cleanly — and only
 * those: see orphans.ts for why a server with a live parent is never touched.
 */
function reapOrphans(): void {
  let listing: string;
  try {
    listing = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 3000 });
  } catch {
    return;
  }
  for (const pid of orphanedServers(listing, modelsDir())) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
  }
}

/**
 * Where speech models live.
 *
 * Installed, they are downloaded into Application Support: the app bundle is
 * read-only (and signed — writing into it would break the signature), and at
 * ~500 MB a model is too big to ship inside the download anyway.
 */
export function modelsDir(): string {
  return app.isPackaged
    ? path.join(app.getPath("userData"), "models")
    : path.join(app.getAppPath(), "resources", "models");
}

function modelPath(modelId: string): string {
  return path.join(modelsDir(), modelById(modelId).file);
}

/**
 * Every server this process has started, so a single exit hook can reap them.
 *
 * This used to be done with `process.once("SIGINT" | "SIGTERM")` inside each
 * start — which had a nasty side effect: installing a signal listener replaces
 * Node's default action, so the first SIGTERM stopped whisper and left the app
 * itself running. Signals are now handled once, in index.ts, by quitting the
 * app, which reaches `stop()` through the normal shutdown path.
 */
const live = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of live) child.kill("SIGKILL");
});

/** Ask the OS for a free port, then hand it to the child. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** More unexpected exits than this in a minute is a crash loop: stop restarting. */
const MAX_RESTARTS_PER_MINUTE = 3;

export interface WhisperOptions {
  /** Lifecycle events worth a line in the log: the server died, came back. */
  trace?: (event: string, data?: Record<string, unknown>) => void;
}

export class WhisperEngine implements SpeechEngine {
  private child: ChildProcess | null = null;
  private port = 0;
  private ready = false;
  private starting: Promise<void> | null = null;
  /** True until started, and again once stopped on purpose. */
  private stopped = true;
  /** When the server last died without being asked to. */
  private crashes: number[] = [];
  /** Set from a crash until the server is back, whichever path restarts it. */
  private crashedAt = 0;
  private vocabulary = "";
  private modelId: string;
  private latency: number;
  private trace: NonNullable<WhisperOptions["trace"]>;

  constructor(modelId: string = DEFAULT_MODEL_ID, opts: WhisperOptions = {}) {
    this.modelId = modelId;
    // Seeded from the catalogue's measured figure until real ones arrive.
    this.latency = modelById(modelId).latencyMs;
    this.trace = opts.trace ?? (() => {});
  }

  /** The model this engine was started with. */
  get model(): string {
    return this.modelId;
  }

  get typicalMs(): number {
    return this.latency;
  }

  setVocabulary(prompt: string): void {
    this.vocabulary = prompt;
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const bin = binaryPath();
    const model = modelPath(this.modelId);
    if (!existsSync(bin)) {
      throw new Error(
        app.isPackaged
          ? "The speech engine is missing from the app. Reinstall Jev Voice Agent."
          : `whisper-server not found at ${bin}. Run \`npm run setup\` first.`,
      );
    }
    if (!existsSync(model)) {
      throw new Error("The speech model is not downloaded yet. Download it in Settings → Voice.");
    }

    reapOrphans();
    this.port = await freePort();
    this.child = spawn(
      bin,
      [
        "-m", model,
        "--host", "127.0.0.1",          // never bind a public interface
        "--port", String(this.port),
        "-nt",                           // no timestamps: we want plain text
        "-t", "4",
        // Suppress non-speech tokens: commands never contain [MUSIC] or (sighs),
        // and letting the decoder consider them only invites hallucination on
        // the near-silence at the edges of an utterance.
        "-sns",
        // Commands are short and clean; greedy decoding is both faster and less
        // prone to the hallucinated filler beam search invents on near-silence.
        "-bo", "1", "-bs", "1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const child = this.child;
    live.add(child);
    child.on("exit", (code, signal) => {
      live.delete(child);
      // Only clear state that still belongs to this child: a model switch may
      // already have started its replacement.
      if (this.child !== child) return;
      this.ready = false;
      this.child = null;
      if (!this.stopped) this.recover(code, signal);
    });

    await this.waitForListening();
    this.ready = true;
    await this.warmup();
    if (this.crashedAt) {
      this.trace("server-restarted", { afterMs: Date.now() - this.crashedAt });
      this.crashedAt = 0;
    }
  }

  /** Poll the server until it answers, rather than guessing a sleep duration. */
  private async waitForListening(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("whisper-server exited during startup");
      try {
        // Any response at all — including a 404 — proves the socket is live.
        await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(500) });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    throw new Error("whisper-server did not start within 30s");
  }

  /**
   * Force the one-time Metal shader compile now.
   *
   * Without this the user's first "Hey Jeff" would appear to hang for ~17 s.
   */
  private async warmup(): Promise<void> {
    const silence = new Float32Array(SAMPLE_RATE); // 1 s
    const typical = this.latency;
    try {
      // Straight to the server: transcribe() would wait for this very start.
      await this.request(silence, {});
    } catch {
      // Warmup is best-effort; a failure here still leaves the server usable.
    }
    // The shader compile says nothing about steady-state speed; do not let it
    // talk the pipeline out of streaming.
    this.latency = typical;
  }

  /**
   * The server died without being asked to — it crashed, or something killed
   * it. Bring it back. Before this, one death left the app answering every
   * command with "speech engine not started" until it was restarted by hand.
   */
  private recover(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > MAX_RESTARTS_PER_MINUTE) {
      // A crash loop: restarting again would only spin. The next command still
      // tries once (see transcribe), so it can come back later on its own.
      this.trace("server-crash-loop", { code, signal, crashes: this.crashes.length });
      return;
    }
    this.trace("server-exited", { code, signal, restarting: true });
    this.crashedAt = now;
    setTimeout(() => {
      if (this.stopped || this.ready) return;
      this.start().catch((err: unknown) =>
        this.trace("server-restart-failed", { message: err instanceof Error ? err.message : String(err) }),
      );
    }, 300).unref();
  }

  async transcribe(samples: Float32Array, opts: TranscribeOptions = {}): Promise<string> {
    if (!this.ready || !this.port) {
      if (this.stopped) throw new Error("speech engine not started");
      // Coming back after the server died: wait for it rather than fail.
      await this.start();
      if (!this.ready || !this.port) throw new Error("speech engine not started");
    }
    try {
      return await this.request(samples, opts);
    } catch (err) {
      // Refused because the server died a moment ago, before its exit had been
      // noticed: wait for it to come back, then try once more.
      if (opts.signal?.aborted || this.stopped || !(await this.died())) throw err;
      await this.start();
      return this.request(samples, opts);
    }
  }

  /** Whether the server has died, allowing a moment for its exit to register. */
  private died(withinMs = 500): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, withinMs);
      child.once("exit", onExit);
    });
  }

  private async request(samples: Float32Array, opts: TranscribeOptions): Promise<string> {
    const form = new FormData();
    // Copy into a plain Uint8Array: Node's Buffer is typed over ArrayBufferLike,
    // which Blob will not accept as a BlobPart.
    const wav = new Uint8Array(encodeWav(samples));
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "text");
    form.append("temperature", "0.0");
    // Bias the decoder toward the words a command is actually made of.
    if (this.vocabulary) form.append("prompt", this.vocabulary);

    const timeout = AbortSignal.timeout(15000);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`whisper-server returned ${res.status}`);
    const text = clean(await res.text());
    // A slow-moving average, so one hiccup does not switch streaming off.
    this.latency = this.latency * 0.8 + (Date.now() - started) * 0.2;
    return text;
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill("SIGTERM");
      live.delete(child);
      // SIGTERM is enough when the server is healthy; a wedged Metal context is
      // not always, and an orphan holds ~500 MB of GPU memory.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    }
  }
}

/**
 * Whisper emits bracketed non-speech annotations — [BLANK_AUDIO], (wind blowing),
 * *music* — especially on near-silence. They are never part of a command.
 */
export function clean(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
