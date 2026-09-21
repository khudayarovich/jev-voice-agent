
/**
 * Does this transcript open with the wake phrase, and what follows it?
 *
 * The keyword spotter is a fast path, not a reliable one: measured against the
 * same phrase at different levels it fires at full scale and misses at ordinary
 * speaking volume, at every threshold. Whisper, already running and returning in
 * ~65 ms, recognises "hey jeff" far more dependably — so the transcript is the
 * primary wake detector and the spotter is optional.
 *
 * Matching is deliberately forgiving at the very start of an utterance, because
 * that is exactly where a recogniser is least certain: leading filler, a clipped
 * first syllable, and the handful of ways "jeff" comes back wrong.
 */

export interface WakeMatch {
  matched: boolean;
  /** Whatever the user said after the wake phrase; "" if nothing. */
  rest: string;
  /** Which phrasing matched, for the log. */
  phrase?: string;
}

/** Filler a recogniser routinely prepends; never part of a command. */
const LEADING_FILLER = /^(?:(?:um|uh|er|ah|oh|hey|hi|ok|okay|so|and|well|yeah)[\s,.!?-]+)+/i;

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Near-misses for the final word of the wake phrase.
 *
 * These are not guesses: "jeff" came back as "jef", "jev" and "chef" in real
 * runs, which is the predictable consequence of asking a recogniser for a short
 * proper noun at the edge of an utterance.
 */
function nameVariants(name: string): string[] {
  const out = new Set<string>([name]);
  if (name.length > 3) out.add(name.slice(0, -1)); // dropped final consonant
  if (/(.)\1$/.test(name)) out.add(name.slice(0, -1)); // "jeff" -> "jef"
  // Voiced/unvoiced confusions at the end of a short name.
  out.add(name.replace(/ff$/, "v"));
  out.add(name.replace(/ff$/, "f"));
  out.add(name.replace(/v$/, "ff"));
  return [...out].filter(Boolean);
}

/** Every spelling of a wake phrase worth accepting. */
export function expandWakePhrase(phrase: string): string[] {
  const words = normalize(phrase).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const last = words[words.length - 1]!;
  const lead = words.slice(0, -1);

  const variants = new Set<string>();
  for (const name of nameVariants(last)) {
    variants.add([...lead, name].join(" "));
    // "hey" is frequently dropped or misheard, so the bare name counts too.
    if (lead.length > 0) variants.add(name);
  }
  return [...variants];
}

/** Levenshtein distance, bounded — these are single short words. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length]!;
}

/**
 * Close enough to be the same short name heard badly.
 *
 * Two edits for a four-letter name sounds generous, but it is what "jeff" heard
 * as "jess" actually costs, and the surrounding rules carry the safety: the lead
 * word must match exactly AND a command must follow, so the only way to trip
 * this is to begin a sentence with "hey <something like jeff>" and then issue an
 * instruction.
 */
function nameIsClose(spoken: string, wanted: string): boolean {
  if (!spoken) return false;
  const allowed = wanted.length <= 3 ? 1 : 2;
  return editDistance(spoken, wanted) <= allowed;
}

export function matchWake(transcript: string, wakeWords: string[]): WakeMatch {
  const cleaned = transcript.replace(LEADING_FILLER, "").trim();
  // Try the original first: stripping filler also strips a leading "hey".
  for (const candidate of [transcript.trim(), cleaned]) {
    const hit = matchOne(candidate, wakeWords);
    if (hit.matched) return hit;
  }
  return { matched: false, rest: "" };
}

function matchOne(transcript: string, wakeWords: string[]): WakeMatch {
  const norm = normalize(transcript);
  if (!norm) return { matched: false, rest: "" };

  const phrases = [...new Set(wakeWords.flatMap(expandWakePhrase))].sort(
    (a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length,
  );

  const words = transcript.trim().split(/\s+/);
  for (const phrase of phrases) {
    const target = phrase.split(" ");
    const head = normalize(words.slice(0, target.length).join(" "));
    if (head !== phrase) continue;
    // Keep the original casing and punctuation of whatever follows.
    const rest = words.slice(target.length).join(" ").replace(/^[\s,.:;!?-]+/, "").trim();
    return { matched: true, rest, phrase };
  }

  // Last resort: the lead word is right but the recogniser mangled the NAME,
  // e.g. "hey jess open safari".
  //
  // The lead must match exactly and only the name is allowed to be fuzzy. A
  // looser rule that merely scored the head as a whole accepted "tell jeff
  // hello", because one word out of two matched — which would turn any sentence
  // mentioning the name into a command.
  for (const wake of wakeWords) {
    const target = normalize(wake).split(" ").filter(Boolean);
    if (target.length < 2) continue;
    if (words.length <= target.length) continue;

    const head = words.slice(0, target.length).map((w) => normalize(w));
    const leadMatches = target
      .slice(0, -1)
      .every((word, i) => head[i] === word);
    if (!leadMatches) continue;

    const spokenName = head[head.length - 1] ?? "";
    const wantedName = target[target.length - 1]!;
    if (!nameIsClose(spokenName, wantedName)) continue;

    const rest = words.slice(target.length).join(" ").replace(/^[\s,.:;!?-]+/, "").trim();
    if (rest) return { matched: true, rest, phrase: normalize(wake) };
  }

  return { matched: false, rest: "" };
}
