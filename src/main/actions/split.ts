import { rankActions } from "./rank.ts";
import { ACTIONS } from "./registry.ts";

/**
 * Split a compound request into separate commands.
 *
 * People chain instructions naturally — "open Firefox and open YouTube" — and
 * running only the first half is a plain failure to do what was asked.
 *
 * The hard part is not splitting, it is knowing when NOT to. "type hello and
 * goodbye" contains "and" but is one command whose payload happens to contain
 * the word. So a split is only accepted when the leading action does not carry
 * free text, and when every piece looks like a command in its own right.
 */

/**
 * Actions whose payload is verbatim text, where a conjunction belongs to the
 * text rather than separating two commands.
 *
 * `open_url` is deliberately NOT here: a web address cannot contain " and " with
 * spaces around it, so "open Firefox and open YouTube" is genuinely two
 * commands. Including it blocked exactly that split.
 */
export const TEXT_PAYLOAD = new Set<string>(["type_text", "web_search", "send_to_app"]);

const SEPARATOR = /\s*(?:,\s*and\s+then|\s+and\s+then|\s+and\s+also|,\s*then|,\s*and|\s+then\b|\s+and\b)\s+/i;

/**
 * What is left after the first `k` clauses: "open Notes and type hello and
 * goodbye" after one clause is "type hello and goodbye". Used once the first
 * clause has already run mid-sentence, so the rest is judged as a whole again
 * and the "and" inside dictation stays where it belongs.
 */
export function clauseTail(transcript: string, k: number): string {
  if (k <= 0) return transcript.trim();
  const re = new RegExp(SEPARATOR.source, "gi");
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(transcript)) !== null) {
    if (++seen === k) return transcript.slice(m.index + m[0].length).trim();
    if (m[0].length === 0) re.lastIndex++;
  }
  return "";
}

/** The request up to its `k`th conjunction: the counterpart of `clauseTail`. */
function clauseHead(transcript: string, k: number): string {
  const re = new RegExp(SEPARATOR.source, "gi");
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(transcript)) !== null) {
    if (++seen === k) return transcript.slice(0, m.index).trim();
    if (m[0].length === 0) re.lastIndex++;
  }
  return transcript.trim();
}

/** Cut at the conjunctions, without judging whether the pieces are commands. */
export function clausesOf(transcript: string): string[] {
  const parts = transcript
    .trim()
    .split(SEPARATOR)
    .map((p) => p.replace(/^[\s,.;]+|[\s,.;!?]+$/g, ""))
    .filter((p) => p.length > 1);
  // "Open and open code app": a false start, said again in full — not a
  // command of its own. Observed in real use.
  return parts.filter((p, i) => {
    const next = parts[i + 1];
    return !(next && !p.includes(" ") && next.toLowerCase().startsWith(`${p.toLowerCase()} `));
  });
}

/** "You are playing a video on YouTube": said for context, not as a command. */
const STATEMENT = /^(?:you are|you're|youre|it is|it's|there is|there's|i am|i'm|this is|that is|we are|now you are)\b/i;

export function splitCommands(transcript: string): string[] {
  let whole = transcript.trim();
  if (!whole) return [];

  // Observed in real use: "you are playing a video on YouTube and make a pause
  // for it" became two pauses, which is none.
  const said = clausesOf(whole);
  if (said.length > 1 && said.some((p) => STATEMENT.test(p))) {
    whole = said.filter((p) => !STATEMENT.test(p)).join(", ");
    if (!whole) return [];
  }

  const parts = clausesOf(whole);

  // One clause left of several: a false start was dropped; the rest stands.
  if (parts.length < 2) return parts.length === 1 && whole.split(SEPARATOR).length > 1 ? [parts[0]!] : [whole];

  const tops = parts.map((part) => rankActions(part, 1)[0]);

  // A request that opens with dictation or a search: the conjunction is part of
  // what the user wants typed or searched for — up to a clause that acts on
  // what the search found: "search for cats and dogs and click the first
  // result" is a search for "cats and dogs", then a click.
  if (tops[0] && TEXT_PAYLOAD.has(tops[0])) {
    const click = tops[0] === "web_search" ? tops.findIndex((top, i) => i > 0 && top === "click_on") : -1;
    return click > 0 ? [clauseHead(whole, click), clauseTail(whole, click)] : [whole];
  }

  // Commands, perhaps ending in one whose text runs to the end: "open Notes and
  // type hello and goodbye" is two commands, and the second keeps its "and".
  // Before this, a request like "open Chrome and search for YouTube" stayed one
  // command whenever the recogniser was too slow to stream, and half of it was
  // lost.
  const text = tops.findIndex((top) => top !== undefined && TEXT_PAYLOAD.has(top));
  const commands = text > 0 ? parts.slice(0, text) : parts;

  // Every piece has to stand on its own as a command, or this was one sentence
  // that merely contained "and".
  if (!commands.every((_, i) => tops[i] !== undefined)) return [whole];
  if (text > 0) return [...commands, clauseTail(whole, text)];

  // And the pieces must not all resolve to the same action, which is what a
  // split sentence like "scroll down and down" looks like.
  if (new Set(tops).size === 1) {
    const only = tops[0];
    if (only && ACTIONS[only].slots && Object.keys(ACTIONS[only].slots).length === 0) {
      return [whole];
    }
  }

  return parts;
}
