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
export const TEXT_PAYLOAD = new Set<string>(["type_text", "web_search"]);

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

/** Cut at the conjunctions, without judging whether the pieces are commands. */
export function clausesOf(transcript: string): string[] {
  return transcript
    .trim()
    .split(SEPARATOR)
    .map((p) => p.replace(/^[\s,.;]+|[\s,.;!?]+$/g, ""))
    .filter((p) => p.length > 1);
}

export function splitCommands(transcript: string): string[] {
  const whole = transcript.trim();
  if (!whole) return [];

  const parts = clausesOf(whole);

  if (parts.length < 2) return [whole];

  // If the request as a whole reads as a text-payload command, the conjunction
  // is part of what the user wants typed or searched for.
  const leading = rankActions(whole, 1)[0];
  if (leading && TEXT_PAYLOAD.has(leading)) return [whole];

  // Every piece has to stand on its own as a command, or this was one sentence
  // that merely contained "and".
  const eachIsCommand = parts.every((part) => {
    const top = rankActions(part, 1)[0];
    return top !== undefined && !TEXT_PAYLOAD.has(top);
  });
  if (!eachIsCommand) return [whole];

  // And the pieces must not all resolve to the same action, which is what a
  // split sentence like "scroll down and down" looks like.
  const actions = parts.map((part) => rankActions(part, 1)[0]);
  if (new Set(actions).size === 1 && actions.length > 1) {
    const only = actions[0];
    if (only && ACTIONS[only].slots && Object.keys(ACTIONS[only].slots).length === 0) {
      return [whole];
    }
  }

  return parts;
}
