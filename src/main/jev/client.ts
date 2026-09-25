import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  type RetryPolicy,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { net, session } from "electron";
import type { ApiKeyStatus } from "../../shared/types.ts";
import { getApiKey, getSettings } from "../settings-store.ts";

/**
 * The Jev (TypeSafe AI) client.
 *
 * Lives in the main process only. The SDK refuses to run in a browser context
 * unless `dangerouslyAllowBrowser` is set, which is the correct default: it
 * keeps the API key out of every renderer.
 */

let client: TypeSafeClient | null = null;
let builtFrom = "";
let lastWarmAt = 0;

/**
 * Per-attempt budget. The API answers in ~310 ms from here when the connection
 * is warm; anything past this is a network problem, and the offline matcher
 * should take over rather than leave the user waiting.
 */
const TIMEOUT_MS = 2500;

/**
 * Retry only when a retry is quick.
 *
 * A pooled connection the server has quietly closed fails at once and succeeds
 * on a fresh one, and a 502-504 from the gateway is usually transient. A timeout
 * has already spent the budget, and a 429 will not clear in the time a spoken
 * command can wait — the SDK's defaults would honour a Retry-After of up to a
 * full minute, which a voice command cannot survive.
 */
const VOICE_RETRY: Partial<RetryPolicy> = {
  maxRetries: 1,
  backoffInitialMs: 50,
  backoffMaxMs: 150,
  httpStatuses: new Set([502, 503, 504]),
  respectRetryAfter: false,
  apiConnectionError: true,
  apiTimeoutError: false,
};

/** Drop the cached client so the next call picks up new settings. */
export function invalidate(): void {
  client = null;
  builtFrom = "";
  lastWarmAt = 0;
}

/** Returns null when no API key is configured. */
export function getClient(): TypeSafeClient | null {
  const key = getApiKey();
  if (!key) return null;

  const { baseUrl, model } = getSettings();
  const signature = `${key.slice(-6)}|${baseUrl}|${model}`;
  if (client && builtFrom === signature) return client;

  try {
    client = new TypeSafeClient({
      apiKey: key,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      defaultModel: model || "jev-latest",
      // Chromium's network stack, not Node's. Node's fetch drops an idle
      // connection after about four seconds, so any command spoken more than a
      // few seconds after the previous one paid for a fresh TCP and TLS
      // handshake. Measured from here: 781 ms per route that way, against
      // 307 ms on Chromium's pooled HTTP/2 session — which also stays warm
      // across long pauses, and honours the system proxy settings.
      fetch: (input, init) => net.fetch(input, init),
      timeout: TIMEOUT_MS,
      retry: VOICE_RETRY,
      logLevel: "warn",
    });
    builtFrom = signature;
    return client;
  } catch {
    // Constructor throws on malformed config (bad key, bad URL).
    client = null;
    return null;
  }
}

/**
 * Open the connection before it is needed.
 *
 * Called the moment someone starts speaking: a command takes at least a second
 * to say, which is ample time to finish a TCP and TLS handshake that would
 * otherwise sit on the critical path. A no-op when the pooled HTTP/2 session is
 * still up.
 */
export function warm(): void {
  const now = Date.now();
  if (now - lastWarmAt < 5000) return;
  lastWarmAt = now;
  const c = getClient();
  if (!c) return;
  try {
    session.defaultSession.preconnect({ url: c.baseURL, numSockets: 1 });
  } catch {
    // Best effort: a failed preconnect just means the request connects itself.
  }
}

/** Human-readable explanation for any SDK failure. */
export function describeError(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return "The API key was rejected (401). Check that it is a current TypeSafe key.";
  }
  if (err instanceof RateLimitError) {
    return "Rate limited (429). The account is over its request budget right now.";
  }
  if (err instanceof APITimeoutError) {
    return `Jev did not answer within ${TIMEOUT_MS / 1000}s — the network may be slow.`;
  }
  if (err instanceof APIConnectionError) {
    return "Could not reach the API — no network, or the base URL is wrong.";
  }
  if (err instanceof APIError) {
    return `API error ${err.status}${err.requestId ? ` (request ${err.requestId})` : ""}.`;
  }
  if (err instanceof TypeSafeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Verify the configured credentials by listing models. */
export async function probe(): Promise<ApiKeyStatus> {
  const c = getClient();
  if (!c) {
    return {
      configured: false,
      ok: false,
      message: "No API key set. Paste your TypeSafe key above.",
    };
  }
  try {
    const started = Date.now();
    const models = await c.models.list();
    const names = models.map((m) => m.name);
    return {
      configured: true,
      ok: true,
      message: `Connected in ${Date.now() - started} ms. ${names.length} model${names.length === 1 ? "" : "s"} available.`,
      models: names,
    };
  } catch (err) {
    return { configured: true, ok: false, message: describeError(err) };
  }
}
