import { net } from "electron";
import { LESSON_SCHEMA } from "./lesson.ts";

/**
 * The teacher: a language model on OpenRouter, GPT-6 Luna by default, asked to
 * design a command when Jev has none for a request. Its answer is held to the
 * lesson schema by structured output, then checked again by checkLesson()
 * before anything is shown to the user — and nothing runs until they say yes.
 */

const API = "https://openrouter.ai/api/v1";

/** Learning is rare and the user is told to wait; a slow answer beats none. */
const TIMEOUT_MS = 45_000;

function explain(status: number, body: string): string {
  if (status === 401) return "The OpenRouter key was rejected";
  if (status === 402) return "The OpenRouter account is out of credit";
  if (status === 429) return "OpenRouter is rate limiting this key; try again shortly";
  if (status >= 500) return "OpenRouter is having trouble; try again shortly";
  const message = (() => {
    try {
      return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    } catch {
      return undefined;
    }
  })();
  return message ? `OpenRouter: ${message}` : `OpenRouter answered ${status}`;
}

export async function askTeacher(
  messages: { role: string; content: string }[],
  opts: { apiKey: string; model: string; signal?: AbortSignal },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await net.fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      // OpenRouter's app attribution headers.
      "http-referer": "https://github.com/khudayarovich/jev-voice-agent",
      "x-title": "JVA",
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "lesson", strict: true, schema: LESSON_SCHEMA },
      },
      reasoning: { effort: "low" },
      max_tokens: 4000,
    }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(explain(res.status, body));
  const content = (JSON.parse(body) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter sent an empty answer");
  return JSON.parse(content);
}

/** Check a key without spending anything: OpenRouter describes the key itself. */
export async function probeTeacher(apiKey: string): Promise<{ ok: boolean; message: string }> {
  if (!apiKey) return { ok: false, message: "No OpenRouter key set." };
  try {
    const started = Date.now();
    const res = await net.fetch(`${API}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, message: explain(res.status, body) };
    const data = (JSON.parse(body) as { data?: { usage?: number; limit?: number | null } }).data ?? {};
    const left = typeof data.limit === "number" ? ` · $${Math.max(0, data.limit - (data.usage ?? 0)).toFixed(2)} of $${data.limit.toFixed(2)} left` : "";
    return { ok: true, message: `Connected in ${Date.now() - started} ms${left}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
