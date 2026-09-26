import { execFileSync } from "node:child_process";
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, type AppSettings } from "../shared/types.ts";
import { deriveKey, newSalt, open, seal } from "./secrets.ts";

/**
 * Persistent settings.
 *
 * The API keys are kept out of the plain settings file, sealed by the app
 * itself (see secrets.ts) — not by `safeStorage`, whose Keychain entry asked
 * for permission again with every build and blocked the app at launch. A key
 * still sealed the old way is opened once, with one last prompt, and moved.
 * Keys are never sent to a renderer: the Settings UI only ever learns whether
 * one is present and its last four characters.
 */

interface Persisted extends AppSettings {
  /** The salt the app's own sealing key is derived with. */
  secretSalt?: string;
  /** The keys, sealed by the app (secrets.ts). */
  apiKeySealed?: string;
  openRouterKeySealed?: string;
  /** base64 of safeStorage.encryptString(apiKey): the old way, read once and moved. */
  apiKeyEnc?: string;
  /** Plain-text fallback, used only when OS encryption is unavailable. */
  apiKeyPlain?: string;
  apiKeyTail?: string;
  /** The OpenRouter key, kept exactly as the TypeSafe one is. */
  openRouterKeyEnc?: string;
  openRouterKeyPlain?: string;
  openRouterKeyTail?: string;
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
  const {
    secretSalt: _s, apiKeySealed: _as, openRouterKeySealed: _os,
    apiKeyEnc: _e, apiKeyPlain: _p, apiKeyTail: _t,
    openRouterKeyEnc: _oe, openRouterKeyPlain: _op, openRouterKeyTail: _ot,
    ...rest
  } = load();
  return rest;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

let machineId: string | null = null;

/** This Mac's hardware id, else its name: what the sealing key is bound to. */
function machine(): string {
  if (machineId) return machineId;
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3000 });
    machineId = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? hostname();
  } catch {
    machineId = hostname();
  }
  return machineId;
}

let sealingKey: Buffer | null = null;

function keyFor(s: Persisted): Buffer {
  if (sealingKey) return sealingKey;
  let salt = s.secretSalt;
  if (!salt) {
    salt = newSalt();
    persist({ ...s, secretSalt: salt });
  }
  sealingKey = deriveKey(machine(), userInfo().username, Buffer.from(salt, "base64"));
  return sealingKey;
}

function sealed(text: string): string {
  return seal(keyFor(load()), text);
}

/**
 * A key sealed the old way, opened once and moved: the Keychain may ask —
 * for the last time.
 */
function moved(which: "apiKey" | "openRouterKey"): string {
  const s = load();
  const enc = s[`${which}Enc`];
  if (!enc) return "";
  let plain = "";
  try {
    plain = safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    // Unreadable — the signing identity changed and access was refused.
    return "";
  }
  if (plain) persist({ ...load(), [`${which}Sealed`]: sealed(plain), [`${which}Enc`]: undefined });
  return plain;
}

function opened(which: "apiKey" | "openRouterKey"): string {
  const s = load();
  const box = s[`${which}Sealed`];
  if (box) return open(keyFor(s), box) ?? "";
  return moved(which);
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
    persist({ ...current, apiKeySealed: undefined, apiKeyEnc: undefined, apiKeyPlain: undefined, apiKeyTail: undefined });
    return;
  }
  persist({ ...current, apiKeySealed: sealed(trimmed), apiKeyEnc: undefined, apiKeyPlain: undefined, apiKeyTail: trimmed.slice(-4) });
}

/** Main-process only. Never expose this over IPC. */
export function getApiKey(): string {
  const s = load();
  const own = opened("apiKey");
  if (own) return own;
  if (s.apiKeyPlain) return s.apiKeyPlain;
  // Convenience for development.
  return process.env.TYPESAFE_API_KEY?.trim() ?? "";
}

export function apiKeySummary(): { present: boolean; tail: string; encrypted: boolean } {
  const s = load();
  const present = Boolean(s.apiKeySealed || s.apiKeyEnc || s.apiKeyPlain || process.env.TYPESAFE_API_KEY);
  return {
    present,
    tail: s.apiKeyTail ?? (process.env.TYPESAFE_API_KEY ? "(env)" : ""),
    encrypted: Boolean(s.apiKeySealed || s.apiKeyEnc),
  };
}

// ---------------------------------------------------------------------------
// OpenRouter key — for learning new commands
// ---------------------------------------------------------------------------

export function setOpenRouterKey(key: string): void {
  const trimmed = key.trim();
  const current = load();
  if (!trimmed) {
    persist({ ...current, openRouterKeySealed: undefined, openRouterKeyEnc: undefined, openRouterKeyPlain: undefined, openRouterKeyTail: undefined });
    return;
  }
  persist({ ...current, openRouterKeySealed: sealed(trimmed), openRouterKeyEnc: undefined, openRouterKeyPlain: undefined, openRouterKeyTail: trimmed.slice(-4) });
}

/** Main-process only. Never expose this over IPC. */
export function getOpenRouterKey(): string {
  const s = load();
  const own = opened("openRouterKey");
  if (own) return own;
  if (s.openRouterKeyPlain) return s.openRouterKeyPlain;
  return process.env.OPENROUTER_API_KEY?.trim() ?? "";
}

export function openRouterKeySummary(): { present: boolean; tail: string; encrypted: boolean } {
  const s = load();
  const present = Boolean(s.openRouterKeySealed || s.openRouterKeyEnc || s.openRouterKeyPlain || process.env.OPENROUTER_API_KEY);
  return {
    present,
    tail: s.openRouterKeyTail ?? (process.env.OPENROUTER_API_KEY ? "(env)" : ""),
    encrypted: Boolean(s.openRouterKeySealed || s.openRouterKeyEnc),
  };
}
