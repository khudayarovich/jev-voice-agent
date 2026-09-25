/**
 * Repairs mangled proper nouns in a transcript.
 *
 * Recognisers fail on names, and they fail in a specific way: the consonants
 * survive and the vowels wander. "Claude" came back as "clawed", "clod",
 * "cloudy" and "oldie"; "Termius" as "termias"; "Bitwarden" as "Beating Warden".
 * Every one of those is recoverable if you know the name was probably an
 * application, and this machine knows exactly which applications exist.
 *
 * So rather than chase a bigger model — the largest one tested was WORSE on
 * these names than the small English one — the transcript is repaired against
 * the real app list afterwards. That works regardless of which model is running.
 */

/**
 * Consonant skeleton of a word.
 *
 * Vowels are what recognisers get wrong, so they are discarded. What remains is
 * a shape: "claude", "clawed", "clod" and "cloudy" all reduce to "cld".
 */
export function skeleton(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/[aeiouwhy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** Levenshtein distance, for short strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * Words that must never be rewritten into an app name.
 *
 * Without this, "close" becomes "Clock" and "search" becomes "Safari" — the
 * repair would eat the command itself. These are the verbs and connectives the
 * registry is built from.
 */
const PROTECTED = new Set([
  "open", "close", "quit", "exit", "switch", "launch", "start", "stop", "go",
  "show", "hide", "run", "play", "pause", "next", "previous", "back", "forward",
  "set", "turn", "make", "take", "type", "write", "search", "google", "find",
  "look", "scroll", "up", "down", "left", "right", "volume", "screen", "screenshot",
  "window", "tab", "desktop", "dark", "mode", "light", "mute", "unmute", "lock",
  "sleep", "wake", "copy", "paste", "cut", "undo", "redo", "save", "select", "all",
  "the", "a", "an", "to", "of", "on", "in", "at", "and", "or", "then", "it", "this",
  "that", "my", "me", "please", "thanks", "thank", "you", "is", "for", "with",
  "browser", "app", "application", "file", "folder", "trash", "percent", "times",
  "hey", "jeff", "jev", "yes", "no", "okay", "ok",
  "photo", "picture", "selfie", "camera", "settings", "page", "site",
]);

/** "note" and "notes", "match" and "matches": one word, two numbers. */
function sameWordPlural(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === `${short}s` || long === `${short}es`;
}

export interface RepairResult {
  text: string;
  /** What was changed, for the log. */
  repairs: { from: string; to: string }[];
}

/**
 * Rewrite near-miss app names in a transcript.
 *
 * Only rewrites when the consonant shapes match and the spelling is close,
 * because a false repair turns a working command into a broken one.
 */
export function repairAppNames(transcript: string, appNames: string[]): RepairResult {
  const repairs: { from: string; to: string }[] = [];
  if (!transcript.trim() || appNames.length === 0) return { text: transcript, repairs };

  // Index apps by the shape of their name, for one- and two-word forms.
  const bySkeleton = new Map<string, string>();
  for (const app of appNames) {
    const key = skeleton(app);
    if (key.length >= 2 && !bySkeleton.has(key)) bySkeleton.set(key, app);
  }

  const words = transcript.split(/(\s+)/); // keep the whitespace
  const out = [...words];

  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;
    if (/^\s*$/.test(raw)) continue;
    const bare = raw.replace(/[^A-Za-z]/g, "");
    if (bare.length < 3) continue;
    if (PROTECTED.has(bare.toLowerCase())) continue;

    // Already an exact app name? Leave it alone.
    if (appNames.some((a) => a.toLowerCase() === bare.toLowerCase())) continue;

    const shape = skeleton(bare);
    if (shape.length < 2) continue;

    let best: { app: string; score: number } | null = null;
    for (const [key, app] of bySkeleton) {
      // The opening consonant must agree. Recognisers wander through vowels and
      // word endings but almost never change the sound a word starts with, and
      // without this rule "cats" was being rewritten to "Notes".
      if (shape[0] !== key[0]) continue;

      // "create a new note" is not about the Notes app. The singular of an app
      // named with a plain noun is that noun — note, photo, message, reminder —
      // and rewriting it broke the command it was in. A name said in the
      // singular still reaches the right app through the router, which is
      // allowed to read "note" as Notes when that is what was meant.
      if (sameWordPlural(bare.toLowerCase(), app.toLowerCase())) continue;

      // One consonant out is a near miss in a long shape, but in a two-letter
      // one it is half the evidence gone: "photo" (f-t) became "Phone" (f-n),
      // and "take a photo" opened the Phone app. Short shapes must match.
      const shapeDistance = distance(shape, key);
      if (shapeDistance > (Math.min(shape.length, key.length) <= 2 ? 0 : 1)) continue;

      // Shapes agree; require the spellings to be in the same neighbourhood too,
      // so "clod" can become "Claude" but "cold" does not become "Clock".
      const spellDistance = distance(bare.toLowerCase(), app.toLowerCase());
      const allowed = Math.max(2, Math.ceil(app.length * 0.4));
      if (spellDistance > allowed) continue;

      const score = shapeDistance * 10 + spellDistance;
      if (!best || score < best.score) best = { app, score };
    }

    if (best && best.app.toLowerCase() !== bare.toLowerCase()) {
      // Preserve any trailing punctuation the recogniser added.
      const trailing = raw.match(/[^A-Za-z]*$/)?.[0] ?? "";
      out[i] = best.app + trailing;
      repairs.push({ from: bare, to: best.app });
    }
  }

  return { text: out.join(""), repairs };
}
