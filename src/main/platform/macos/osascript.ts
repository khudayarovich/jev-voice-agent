import { execFile } from "node:child_process";

/**
 * AppleScript / JXA execution with a *double* timeout.
 *
 * macOS 26 (Tahoe) has a documented regression class where Apple Events hang
 * instead of returning an error: the send blocks until AppleScript's own default
 * timeout expires, which is two minutes, and only then yields -1712. A two
 * minute hang inside a voice assistant is indistinguishable from a crash.
 *
 * So every script gets two independent guards:
 *   1. `with timeout of N seconds ... end timeout` *inside* the script, which
 *      bounds each Apple Event send.
 *   2. A hard `execFile` timeout *outside* it, which kills the osascript process
 *      even if the inner guard is bypassed (it only covers event sends, not,
 *      say, a wedged `do shell script`).
 */

/** Well-known AppleScript / Apple Event error numbers we act on. */
export const AE_ERRORS = {
  /** User denied the Automation (Apple Events) grant for this target app. */
  NOT_AUTHORIZED: -1743,
  /** Apple Event timed out. */
  TIMEOUT: -1712,
  /** Target application is not running. */
  PROC_NOT_FOUND: -600,
  /** Application isn't running (variant). */
  APP_NOT_RUNNING: -609,
  /** Accessibility (assistive access) is not enabled for this process. */
  NOT_ALLOWED_ASSISTIVE: -25211,
  /** System Events: "UI element accessibility is disabled" era code. */
  ACCESSIBILITY_DISABLED: -1719,
} as const;

export interface OsaResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Parsed AppleScript error number, when the script failed with one. */
  errorCode: number | null;
  /** True when the outer process kill fired (a genuine hang). */
  timedOut: boolean;
}

export interface OsaOptions {
  /** Hard process kill, milliseconds. Default 5000 — interactive budget. */
  timeoutMs?: number;
  /** Inner `with timeout of N seconds`. Default derived from timeoutMs. */
  innerTimeoutSec?: number;
  /** Run as JavaScript for Automation instead of AppleScript. */
  language?: "AppleScript" | "JavaScript";
  /** Skip the inner wrapper (for scripts that are not a single event send). */
  noWrap?: boolean;
}

/** Extract the trailing "(-1743)" error number osascript prints on stderr. */
function parseErrorCode(stderr: string): number | null {
  const m = stderr.match(/\((-?\d{2,6})\)\s*$/m);
  return m?.[1] ? Number(m[1]) : null;
}

export function runAppleScript(script: string, opts: OsaOptions = {}): Promise<OsaResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const language = opts.language ?? "AppleScript";
  // Leave the inner guard comfortably below the outer kill so we get a real
  // AppleScript error (which names the culprit) rather than an opaque SIGTERM.
  const innerSec = opts.innerTimeoutSec ?? Math.max(1, Math.floor((timeoutMs * 0.8) / 1000));

  const source =
    language === "AppleScript" && !opts.noWrap
      ? `with timeout of ${innerSec} seconds\n${script}\nend timeout`
      : script;

  const args = language === "JavaScript" ? ["-l", "JavaScript", "-"] : ["-"];

  return new Promise<OsaResult>((resolve) => {
    const child = execFile(
      "/usr/bin/osascript",
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const timedOut = Boolean(
          err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed,
        );
        resolve({
          ok: !err,
          stdout: String(stdout ?? "").trim(),
          stderr: String(stderr ?? "").trim(),
          errorCode: err ? parseErrorCode(String(stderr ?? "")) : null,
          timedOut,
        });
      },
    );
    child.stdin?.end(source);
  });
}

/** Convenience: run and return stdout, or throw with a useful message. */
export async function osa(script: string, opts: OsaOptions = {}): Promise<string> {
  const r = await runAppleScript(script, opts);
  if (r.ok) return r.stdout;
  if (r.timedOut) throw new Error(`AppleScript timed out after ${opts.timeoutMs ?? 5000}ms`);
  throw new Error(r.stderr || `AppleScript failed (${r.errorCode ?? "unknown"})`);
}

/** Escape a JS string for embedding in an AppleScript double-quoted literal. */
export function asStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
