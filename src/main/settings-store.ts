import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type AppSettings } from "../shared/types.ts";

/**
 * Persistent settings.
 *
 * The API key is kept out of the plain settings file and encrypted with
 * `safeStorage`, which on macOS is backed by the Keychain. It is never sent to a
 * renderer — the Settings UI only ever learns whether a key is present and what
 * its last four characters are.
 */

interface Persisted extends AppSettings {
  /** base64 of safeStorage.encryptString(apiKey) */
  apiKeyEnc?: string;
  /** Plain-text fallback, used only when OS encryption is unavailable. */
  apiKeyPlain?: string;
  apiKeyTail?: string;
}

let cache: Persisted | null = null;

function file(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function load(): Persisted {
  if (cache) return cache;
  const f = file();
  let raw: Partial<Persisted> = {};
  if (existsSync(f)) {
    try {
      raw = JSON.parse(readFileSync(f, "utf8")) as Partial<Persisted>;
    } catch {
      // A corrupt settings file must not brick the app; fall back to defaults.
      raw = {};
    }
  }
  cache = { ...DEFAULT_SETTINGS, ...raw };
  return cache;
}

function persist(next: Persisted): void {
  const f = file();
  mkdirSync(path.dirname(f), { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate the real file.
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, f);
  cache = next;
}

export function getSettings(): AppSettings {
  const { apiKeyEnc: _e, apiKeyPlain: _p, apiKeyTail: _t, ...rest } = load();
  return rest;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  persist({ ...load(), ...patch });
  return getSettings();
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

export function setApiKey(key: string): void {
  const trimmed = key.trim();
  const current = load();
  if (!trimmed) {
    persist({ ...current, apiKeyEnc: undefined, apiKeyPlain: undefined, apiKeyTail: undefined });
    return;
  }
  const tail = trimmed.slice(-4);
  if (safeStorage.isEncryptionAvailable()) {
    persist({
      ...current,
      apiKeyEnc: safeStorage.encryptString(trimmed).toString("base64"),
      apiKeyPlain: undefined,
      apiKeyTail: tail,
    });
  } else {
    // Better to work than to fail silently, but say so in the UI.
    persist({ ...current, apiKeyEnc: undefined, apiKeyPlain: trimmed, apiKeyTail: tail });
  }
}

/** Main-process only. Never expose this over IPC. */
export function getApiKey(): string {
  const s = load();
  if (s.apiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, "base64"));
    } catch {
      // Keychain item unreadable (e.g. after a signing-identity change).
      return "";
    }
  }
  if (s.apiKeyPlain) return s.apiKeyPlain;
  // Convenience for development.
  return process.env.TYPESAFE_API_KEY?.trim() ?? "";
}

export function apiKeySummary(): { present: boolean; tail: string; encrypted: boolean } {
  const s = load();
  const present = Boolean(s.apiKeyEnc || s.apiKeyPlain || process.env.TYPESAFE_API_KEY);
  return {
    present,
    tail: s.apiKeyTail ?? (process.env.TYPESAFE_API_KEY ? "(env)" : ""),
    encrypted: Boolean(s.apiKeyEnc),
  };
}
