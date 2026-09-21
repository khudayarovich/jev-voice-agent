import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { ApiKeyStatus } from "../../shared/types";
import { getApiKey, getSettings } from "../settings-store";

/**
 * The Jev (TypeSafe AI) client.
 *
 * Lives in the main process only. The SDK refuses to run in a browser context
 * unless `dangerouslyAllowBrowser` is set, which is the correct default: it
 * keeps the API key out of every renderer.
 */

let client: TypeSafeClient | null = null;
let builtFrom = "";

/** Drop the cached client so the next call picks up new settings. */
export function invalidate(): void {
  client = null;
  builtFrom = "";
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
      // A voice command that takes longer than this is already too slow to be
      // useful; failing fast lets the offline matcher take over.
      timeout: 4000,
      retry: { maxRetries: 1, backoffInitialMs: 200 },
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

/** Human-readable explanation for any SDK failure. */
export function describeError(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return "The API key was rejected (401). Check that it is a current TypeSafe key.";
  }
  if (err instanceof RateLimitError) {
    return "Rate limited (429). The account is over its request budget right now.";
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
    const models = await c.models.list();
    const names = models.map((m) => m.name);
    return {
      configured: true,
      ok: true,
      message: `Connected. ${names.length} model${names.length === 1 ? "" : "s"} available.`,
      models: names,
    };
  } catch (err) {
    return { configured: true, ok: false, message: describeError(err) };
  }
}
