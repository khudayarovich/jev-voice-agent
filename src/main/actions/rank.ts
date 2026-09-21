import { fuzzyScore } from "./parse.ts";
import { ACTIONS, ACTION_KEYS, type ActionKey } from "./registry.ts";

/**
 * Rank registry actions against the transcript using their example phrasings.
 *
 * This does not decide anything — Jev still chooses from the full registry. It
 * only decides which actions are worth speculatively resolving slots for in the
 * same round trip, since adding questions barely changes Jev's response time but
 * a second round trip would double it.
 */
export function rankActions(transcript: string, limit = 3): ActionKey[] {
  const t = transcript.toLowerCase();
  return ACTION_KEYS.map((key) => {
    const best = ACTIONS[key].examples.reduce((m, ex) => Math.max(m, fuzzyScore(t, ex)), 0);
    // A bare verb match is weak evidence but better than nothing.
    const verbHit = ACTIONS[key].examples.some((ex) => t.startsWith(ex.split(" ")[0] ?? ""));
    return { key, score: best + (verbHit ? 0.2 : 0) };
  })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.key);
}
