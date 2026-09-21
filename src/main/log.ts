import { appendFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Structured file log.
 *
 * A voice agent fails in ways you cannot see: a wake word that never fires, a
 * capture that ends too early, a transcript that arrives 900 ms late. None of
 * that is visible in the UI, and attaching a debugger changes the timing. So
 * every pipeline event lands here as one JSON object per line, with a monotonic
 * millisecond stamp, and `npm run tail` reads it back.
 */

let logPath = "";
const MAX_BYTES = 2 * 1024 * 1024;

export function initLog(): string {
  logPath = path.join(app.getPath("userData"), "jev.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    // Truncate between runs rather than rotating: this is a debugging aid, and
    // a stale tail is worse than no tail.
    if (statSync(logPath).size > MAX_BYTES) rmSync(logPath, { force: true });
  } catch {
    // No existing log, which is fine.
  }
  log("app", "start", { pid: process.pid, electron: process.versions.electron });
  return logPath;
}

export function getLogPath(): string {
  return logPath;
}

export function log(scope: string, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: Date.now(), ms: Math.round(performance.now()), scope, event, ...data });
  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // Never let logging break the pipeline.
    }
  }
  console.log(line);
}
