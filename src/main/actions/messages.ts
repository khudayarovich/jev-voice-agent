/**
 * "Send a prompt to Codex saying fix the tests", "ask ChatGPT what time it is
 * in Tokyo", "tell Codex to run the build": which app, and what to type into
 * it. The app is null when none is named — the one in front is meant, as
 * after "open Codex and send a prompt …".
 */

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PREPOSITION = /^(?:to|in|into|on|ask|tell|open|via|through)$/i;
const ARTICLE = /^(?:the|my|a|an)$/i;
/** Words for the place in the app the text goes: not part of the message. */
const FIELD = /^(?:input|inputs|field|box|chat|window|app|prompt|terminal|console)$/i;

/**
 * The app named right after "to", "in", "ask", "tell" or "open", if any —
 * with or without "the": speech says "the open code" for OpenCode.
 */
function namedApp(words: string[], apps: string[]): { app: string; from: number; to: number } | null {
  const clean = words.map((w) => w.replace(/[,.:;!?]+$/, ""));
  for (let i = 0; i < clean.length; i++) {
    if (!PREPOSITION.test(clean[i]!)) continue;
    const start = i + 1 + (clean[i + 1] && ARTICLE.test(clean[i + 1]!) ? 1 : 0);
    for (const len of [3, 2, 1]) {
      const phrase = clean.slice(start, start + len).join(" ");
      const app = apps.find((a) => squash(a) === squash(phrase));
      if (!app) continue;
      let end = start + len;
      // "to the open code input": the field is where, not what.
      while (clean[end] && (FIELD.test(clean[end]!) || (ARTICLE.test(clean[end]!) && clean[end + 1] && FIELD.test(clean[end + 1]!)))) end++;
      return { app, from: i, to: end };
    }
  }
  return null;
}

export function messageRequest(transcript: string, apps: string[]): { app: string | null; text: string | null } {
  const t = transcript.trim().replace(/^(?:and|then|please|now)\s+/i, "");
  let words = t.split(/\s+/);
  const named = namedApp(words, apps);
  if (named) {
    // "to Codex", "ask ChatGPT": the app's words are not part of the message,
    // but "ask" and "tell" still say what is being done.
    const verb = /^(?:ask|tell|open)$/i.test(words[named.from]!.replace(/[,.:;]+$/, "")) ? [words[named.from]!] : [];
    words = [...words.slice(0, named.from), ...verb, ...words.slice(named.to)];
  }
  const rest = words.join(" ").replace(/^\s*(?:and\s+)?/, "");
  const m = rest.match(
    /^(?:(?:send|write|type|enter|submit|put)\s+(?:it\s+|him\s+|her\s+|them\s+)?(?:a\s+|the\s+|this\s+)?(?:prompt|message|text|question|command|task|tasks)?\s*(?:saying|that says|which says|with|of|:|,)?|ask\s+(?:it|him|her|them)?\s*(?:to\s+)?|tell\s+(?:it|him|her|them)?\s*(?:to\s+)?|open\s+(?:it\s+)?and\s+(?:send|ask|tell|type)\s+(?:it\s+)?(?:a\s+|the\s+)?(?:prompt|message)?\s*(?:saying|:|,)?)\s*(.*)$/i,
  );
  let text = m?.[1]?.trim() ?? null;
  if (text) {
    text = text
      .replace(/^[:,\-–—]\s*/, "")
      // "hello to the input", "hello in the chat": where it goes, said after.
      .replace(/\s+(?:to|in|into|on)\s+(?:the\s+|its\s+)?(?:input|input field|chat|text field|prompt|box|field|terminal|console)(?:\s+field)?$/i, "")
      .replace(/^(?:saying|that says)\s+/i, "")
      .replace(/[.]+$/, "")
      .trim();
  }
  return { app: named?.app ?? null, text: text || null };
}
