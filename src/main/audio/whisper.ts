import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";
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

export interface SpeechEngine {
  start(): Promise<void>;
  stop(): void;
  transcribe(samples: Float32Array): Promise<string>;
  isReady(): boolean;
}

function binaryPath(): string {
  const candidates = [
    // Bundled with a packaged build.
    path.join(process.resourcesPath ?? "", "whisper", "whisper-server"),
    // Development: built into vendor/ by scripts/setup-whisper.sh
    path.join(app.getAppPath(), "vendor", "whisper.cpp", "build", "bin", "whisper-server"),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? candidates[1]!;
}

/**
 * Where the running child's PID is recorded.
 *
 * The child outlives the parent if Electron dies abnormally — a native abort in
 * an addon, say — leaving an orphaned server holding a port and ~150 MB. On the
 * next start we read this and clean up before spawning a new one.
 */
function pidFile(): string {
  return path.join(app.getPath("userData"), "whisper-server.pid");
}

/** Kill a server left behind by a previous run that did not exit cleanly. */
function reapStale(): void {
  const file = pidFile();
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8").trim());
  rmSync(file, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    // Confirm it is actually ours before signalling: PIDs get reused.
    const cmd = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    if (cmd.includes("whisper-server")) process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, which is the outcome we wanted anyway.
  }
}

function modelPath(): string {
  return path.join(app.getAppPath(), "resources", "models", "ggml-base.en.bin");
}

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

export class WhisperEngine implements SpeechEngine {
  private child: ChildProcess | null = null;
  private port = 0;
  private ready = false;
  private starting: Promise<void> | null = null;

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const bin = binaryPath();
    const model = modelPath();
    if (!existsSync(bin)) throw new Error(`whisper-server not found at ${bin}. Run scripts/setup-whisper.sh`);
    if (!existsSync(model)) throw new Error(`model not found at ${model}. Run scripts/setup-whisper.sh`);

    reapStale();
    this.port = await freePort();
    this.child = spawn(
      bin,
      [
        "-m", model,
        "--host", "127.0.0.1",          // never bind a public interface
        "--port", String(this.port),
        "-nt",                           // no timestamps: we want plain text
        "-t", "4",
        // Commands are short and clean; greedy decoding is both faster and less
        // prone to the hallucinated filler beam search invents on near-silence.
        "-bo", "1", "-bs", "1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    if (this.child.pid) writeFileSync(pidFile(), String(this.child.pid), "utf8");

    this.child.on("exit", () => {
      this.ready = false;
      this.child = null;
      rmSync(pidFile(), { force: true });
    });

    // Electron's before-quit runs on a clean exit, but not on a crash or a
    // signal. These cover the rest.
    process.once("exit", () => this.stop());
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => this.stop());

    await this.waitForListening();
    this.ready = true;
    await this.warmup();
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
    try {
      await this.transcribe(silence);
    } catch {
      // Warmup is best-effort; a failure here still leaves the server usable.
    }
  }

  async transcribe(samples: Float32Array): Promise<string> {
    if (!this.ready || !this.port) throw new Error("speech engine not started");

    const form = new FormData();
    // Copy into a plain Uint8Array: Node's Buffer is typed over ArrayBufferLike,
    // which Blob will not accept as a BlobPart.
    const wav = new Uint8Array(encodeWav(samples));
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "text");
    form.append("temperature", "0.0");

    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`whisper-server returned ${res.status}`);
    return clean(await res.text());
  }

  stop(): void {
    this.ready = false;
    this.child?.kill("SIGTERM");
    this.child = null;
    rmSync(pidFile(), { force: true });
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
