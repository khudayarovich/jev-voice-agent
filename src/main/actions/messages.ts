/**
 * "Send a prompt to Codex saying fix the tests", "ask ChatGPT what time it is
 * in Tokyo", "tell Codex to run the build": which app, and what to type into
 * it. The app is null when none is named — the one in front is meant, as
 * after "open Codex and send a prompt …".
 */

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The app named right after "to", "in", "ask", "tell" or "open", if any. */
function namedApp(transcript: string, apps: string[]): { app: string; phrase: string } | null {
  const words = transcript.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:to|in|into|on|ask|tell|open|via|through)$/i.test(words[i]!.replace(/[,.:;]+$/, ""))) continue;
    for (const len of [3, 2, 1]) {
      const phrase = words.slice(i + 1, i + 1 + len).join(" ").replace(/[,.:;]+$/, "");
      const app = apps.find((a) => squash(a) === squash(phrase));
      if (app) return { app, phrase };
    }
  }
  return null;
}

export function messageRequest(transcript: string, apps: string[]): { app: string | null; text: string | null } {
  let t = transcript.trim().replace(/^(?:and|then|please|now)\s+/i, "");
  const named = namedApp(t, apps);
  if (named) {
    // "to Codex", "ask ChatGPT": the app's words are not part of the message.
    t = t.replace(new RegExp(`\\b(?:to|in|into|on|via|through)\\s+${named.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?`, "i"), " ")
      .replace(new RegExp(`^(ask|tell|open)\\s+${named.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?\\s*(?:and\\s+)?`, "i"), "$1 ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const m = t.match(
    /^(?:(?:send|write|type|enter|submit)\s+(?:it\s+|him\s+|her\s+|them\s+)?(?:a\s+|the\s+|this\s+)?(?:prompt|message|text|question|command)?\s*(?:saying|that says|with|of|:|,)?|ask\s+(?:it|him|her|them)?\s*(?:to\s+)?|tell\s+(?:it|him|her|them)?\s*(?:to\s+)?|open\s+(?:it\s+)?and\s+(?:send|ask|tell|type)\s+(?:it\s+)?(?:a\s+|the\s+)?(?:prompt|message)?\s*(?:saying|:|,)?)\s*(.+)$/i,
  );
  const text = m?.[1]?.trim().replace(/^[:,\-–—]\s*/, "").replace(/[.]+$/, "") ?? null;
  return { app: named?.app ?? null, text: text || null };
}
