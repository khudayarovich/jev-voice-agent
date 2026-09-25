/**
 * Deterministic extraction from a transcript.
 *
 * Everything numeric lives here rather than in a Jev question, on the model's
 * own advice: it is documented as unreliable at arithmetic, counting, and date
 * comparison, and recommends implementing that logic in code. Code is also
 * exact, free, and instant — there is no reason to ask.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Spoken English number to a value. Handles "a hundred", "twenty five", "35". */
export function parseSpokenNumber(text: string): number | null {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s.-]/g, " ");

  // Digits win when present: speech-to-text usually normalises them already.
  const digits = cleaned.match(/\b(\d{1,3}(?:\.\d+)?)\b/);
  if (digits?.[1]) {
    const n = Number(digits[1]);
    if (Number.isFinite(n)) return n;
  }

  const words = cleaned.split(/[\s-]+/).filter(Boolean);
  let total: number | null = null;
  let current = 0;
  let matched = false;

  for (const word of words) {
    if (word === "and" && matched) continue;
    if (UNITS[word] !== undefined) {
      current += UNITS[word];
      matched = true;
    } else if (TENS[word] !== undefined) {
      current += TENS[word];
      matched = true;
    } else if (word === "hundred") {
      current = (current || 1) * 100;
      matched = true;
    } else if (matched) {
      // The number ended; stop rather than absorbing later words.
      break;
    }
  }
  if (!matched) return null;
  total = current;
  return total;
}

/** A percentage, with the words people actually use for the extremes. */
export function parsePercent(transcript: string): number | null {
  const t = transcript.toLowerCase();
  if (/\b(mute|silent|zero|off)\b/.test(t)) return 0;
  if (/\bmax(imum)?\b|\bfull\b|\ball the way up\b/.test(t)) return 100;
  if (/\bhalf\b/.test(t)) return 50;
  const n = parseSpokenNumber(t);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

/** "three times", "twice", "a bit" -> a repeat count. */
export function parseCount(transcript: string, fallback = 1): number {
  const t = transcript.toLowerCase();
  if (/\b(twice|two times)\b/.test(t)) return 2;
  if (/\b(thrice|three times)\b/.test(t)) return 3;
  if (/\b(a lot|way|much)\b/.test(t)) return 5;
  if (/\b(a bit|a little|slightly)\b/.test(t)) return 1;
  const m = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+times?\b/);
  if (m?.[1]) {
    const n = parseSpokenNumber(m[1]);
    if (n !== null) return Math.max(1, Math.min(20, n));
  }
  return fallback;
}

/**
 * Text that follows a lead-in phrase, taken verbatim.
 *
 * The span is copied out of the transcript unchanged — this is extraction, not
 * generation, so nothing can be invented or paraphrased.
 */
export function afterPhrase(transcript: string, leads: string[]): string | null {
  const t = transcript.trim();
  for (const lead of leads.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s:,-]*`, "i");
    const m = re.exec(t);
    if (m && m.index + m[0].length < t.length) {
      return t.slice(m.index + m[0].length).trim().replace(/[.?!]+$/, "");
    }
  }
  return null;
}

/**
 * Sites people name rather than spell.
 *
 * "open YouTube" is a website, not an application — there is no YouTube.app to
 * find, so without this the command routes to open_app and dies looking for it.
 */
const KNOWN_SITES: Record<string, string> = {
  youtube: "youtube.com",
  github: "github.com",
  gmail: "mail.google.com",
  google: "google.com",
  "google drive": "drive.google.com",
  reddit: "reddit.com",
  wikipedia: "wikipedia.org",
  twitter: "twitter.com",
  x: "x.com",
  amazon: "amazon.com",
  netflix: "netflix.com",
  linkedin: "linkedin.com",
  "stack overflow": "stackoverflow.com",
  stackoverflow: "stackoverflow.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  chatgpt: "chatgpt.com",
  claude: "claude.ai",
  "hacker news": "news.ycombinator.com",
  twitch: "twitch.tv",
  spotify: "open.spotify.com",
  maps: "maps.google.com",
};

/** A URL or bare domain mentioned in the transcript. */
export function extractUrl(transcript: string): string | null {
  const explicit = transcript.match(/\bhttps?:\/\/\S+/i);
  if (explicit?.[0]) return explicit[0];
  // Speech renders "github dot com" literally often enough to be worth handling.
  const spoken = transcript
    .toLowerCase()
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+slash\s+/g, "/");
  const domain = spoken.match(
    /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)\b/i,
  );
  if (domain?.[1]) {
    const tld = domain[1].split("/")[0]!.split(".").pop()!;
    if (/^[a-z]{2,}$/i.test(tld) && tld.length <= 6) return domain[1];
  }

  // No address spelled out — check whether they named a site instead. Longest
  // first so "google drive" wins over "google".
  const words = spoken.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const name of Object.keys(KNOWN_SITES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`).test(words)) return KNOWN_SITES[name]!;
  }
  return null;
}


/**
 * Words that carry no evidence about which command was meant.
 *
 * Without this, "set the volume to half" scores against "what about the weather
 * today" purely on the word "the". Command-meaningful words like up, down, off,
 * back and next are deliberately NOT in here.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "it", "this", "that", "is", "are", "and",
  "for", "in", "on", "my", "me", "please", "some", "at",
]);

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/**
 * Does a run of adjacent spoken words spell the candidate once squashed
 * together? "vs code" is "VSCode", "php storm" is "PhpStorm", "iterm two" is
 * "iTerm2".
 *
 * Runs must start and end on word boundaries. Squashing the whole transcript
 * into one string and searching inside it was the earlier approach, and it let
 * the command verb bleed into the name: "open codex" squashed is "opencodex",
 * which contains "opencode" — so the agent opened OpenCode.
 */
function adjacentWordsSpell(words: string[], flat: string): boolean {
  const spoken = words.map((w) => DIGIT_WORDS[w] ?? w);
  for (let i = 0; i < spoken.length; i++) {
    let joined = "";
    for (let j = i; j < spoken.length && joined.length < flat.length; j++) {
      joined += spoken[j];
      if (j > i && joined === flat) return true;
    }
  }
  return false;
}

/**
 * Score how well a transcript names a candidate.
 *
 * Used to shortlist candidates BEFORE asking Jev, which keeps `state` small —
 * the model degrades when the state is padded with irrelevant detail. Jev still
 * makes the final choice; this only decides what it gets to choose between.
 *
 * Matching is on whole words, never substrings. Substring matching looks fine
 * until "to" matches inside "today" and every command containing "to" scores
 * against an unrelated sentence.
 */
export function fuzzyScore(transcript: string, candidate: string): number {
  const c = candidate.toLowerCase().trim();
  if (!c) return 0;

  const spoken = wordsOf(transcript);
  const transcriptWords = new Set(spoken);

  // A verbatim mention is the strongest possible signal — as whole words, so
  // "Notes" is not found inside "denotes".
  const cWords = wordsOf(c);
  if (cWords.length > 0 && containsRun(spoken, cWords)) return 1 + c.length / 100;

  const all = wordsOf(c);
  if (all.length === 0) return 0;
  // Prefer content words; fall back to everything if the candidate is all
  // stopwords (which real app names never are).
  const content = all.filter((w) => !STOPWORDS.has(w));
  const scored = content.length > 0 ? content : all;

  const hits = scored.filter((w) => transcriptWords.has(w)).length;
  if (hits === 0) {
    // "iTerm 2" said as "iterm two", "VSCode" said as "vs code".
    return adjacentWordsSpell(spoken, all.join("")) ? 0.9 : 0;
  }
  return hits / scored.length;
}

/** Does `words` contain `run` as consecutive whole words? */
function containsRun(words: string[], run: string[]): boolean {
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer;
    return true;
  }
  return false;
}

/** The best-matching candidates, highest first. */
export function shortlistBy(
  transcript: string,
  candidates: string[],
  limit: number,
  floor = 0.5,
): string[] {
  return candidates
    .map((c) => ({ c, s: fuzzyScore(transcript, c) }))
    .filter((x) => x.s >= floor)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}
