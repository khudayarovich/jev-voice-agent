import { parameterValue } from "../learning/lesson.ts";
import { missingSlots } from "./execute.ts";
import { rankActions } from "./rank.ts";
import { ACTIONS, ACTION_KEYS, type ActionKey } from "./registry.ts";
import { siteNamed } from "./parse.ts";
import { type RouteDecision, certainChoice, resolveLocalSlots } from "./resolve.ts";
import { TEXT_PAYLOAD, clausesOf } from "./split.ts";
import type { ActionContext } from "./types.ts";

/**
 * Deciding what can be acted on before the user has finished talking.
 *
 * The agent no longer waits for a long silence, then transcribes, then routes.
 * It transcribes while the user speaks and at every pause, routes what it has,
 * and acts the moment a command is complete — so "open Notes and make a new
 * note" opens Notes while the second half is still being said. Everything here
 * is about doing that without acting on half a sentence.
 *
 * Pure functions, no Electron: this is the part most worth testing.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Words a finished command never ends on. "set the volume to", "open my",
 * "search for" — a pause after one of these is the user thinking, not done.
 *
 * "this" and "that" are deliberately absent: "copy that", "close this".
 */
const DANGLING = new Set([
  "to", "the", "a", "an", "and", "or", "but", "of", "for", "with", "on", "in",
  "at", "into", "onto", "from", "by", "about", "then", "my", "your", "our",
  "their", "his", "her", "its", "some", "um", "uh", "er", "like", "also",
]);

/** Verbs that are not a command on their own: "open", "type", "set"… */
const NEEDS_OBJECT = new Set([
  "open", "launch", "start", "quit", "close", "exit", "hide", "type", "write",
  "dictate", "search", "google", "look", "set", "turn", "switch", "go", "run",
  "make", "take", "show", "visit", "find", "put", "move", "snap", "tile",
  "click", "tap", "press", "select", "choose", "pick",
]);

/**
 * Does this transcript read as the user still being mid-sentence?
 *
 * Used twice: to hold off acting on what was heard at a pause, and to give the
 * speaker longer before deciding the utterance is over.
 */
export function isIncomplete(transcript: string): boolean {
  const t = transcript.trim();
  if (!t) return true;
  // Recognisers mark an unfinished thought: "open the…", "set volume to,".
  if (/(\.\.\.|…|,|-|—|:)$/.test(t)) return true;
  const words = norm(t).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const last = words[words.length - 1]!;
  if (DANGLING.has(last)) return true;
  return words.length === 1 && NEEDS_OBJECT.has(last);
}

/** "and then go to GitHub" — a follow-on clause, said after a pause. */
export function stripLeadingConjunction(transcript: string): string {
  return transcript.replace(/^\s*(?:and\s+then|and\s+also|and|then|also|plus)\b[\s,]*/i, "").trim();
}

/**
 * The clauses of a still-growing transcript that are already finished.
 *
 * "open Notes and create a" → ["open Notes"]: a conjunction followed by more
 * speech proves the clause before it is over, so it can run now. The last
 * clause never counts — the user is still saying it. Refuses outright when the
 * sentence as a whole is dictation or a search, where "and" belongs to the text.
 */
export function completedClauses(transcript: string): string[] {
  const parts = clausesOf(transcript);
  if (parts.length < 2) return [];
  const leading = rankActions(transcript, 1)[0];
  if (leading && TEXT_PAYLOAD.has(leading)) return [];

  const done: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const top = rankActions(part, 1)[0];
    if (!top || TEXT_PAYLOAD.has(top) || isIncomplete(part)) break;
    done.push(part);
  }
  return done;
}

/** Below this, Jev thinks the user was talking to someone else. */
export const ADDRESSED_MIN = 0.35;

/**
 * The same, for speech in an open conversation, which needs no wake word — so
 * whatever is said nearby arrives as if it were a command. Measured in real
 * use: the user's own follow-up commands scored 0.80–0.96, while a video
 * playing in the room scored 0.12–0.48, and at 0.48 it opened System Settings.
 */
export const FOLLOWUP_ADDRESSED_MIN = 0.6;

/**
 * Below this, Jev is unsure which app (or other option) was meant, even if the
 * command itself is clear — "open my code editor" with several installed came
 * back at 0.50. Better to ask than to open the wrong thing. The same bar as the
 * command's own default threshold.
 */
export const SLOT_CONFIDENCE_MIN = 0.55;

/**
 * Safe to run at a pause, before the silence that ends the utterance?
 *
 * Only a complete, confident, fully-resolved decision. Dictation and searches
 * wait for the real end: a pause in "type dear Sarah … thank you" is not the
 * end of the text. Destructive actions pass — acting on them early only means
 * asking "are you sure?" sooner.
 */
export function actsEarly(
  d: RouteDecision,
  clause: string,
  confidenceThreshold: number,
  addressedMin = ADDRESSED_MIN,
): boolean {
  if (!d.action) return false;
  if (d.addressed < addressedMin) return false;
  if (d.confidence < confidenceThreshold) return false;
  if (d.slotConfidence !== undefined && d.slotConfidence < SLOT_CONFIDENCE_MIN) return false;
  if (missingSlots(d.action, d.args).length > 0) return false;
  // Dictation, a search, and what to click: a pause inside the words ("click
  // on sign… in with Google") is not the end of them.
  if (TEXT_PAYLOAD.has(d.action) || d.action === "click_on") return false;
  return !isIncomplete(clause);
}

// ---------------------------------------------------------------------------
// Instant path
// ---------------------------------------------------------------------------

/** "open Safari", "launch the Terminal app", "switch to Slack, please". */
const OPEN_APP = /^(?:please\s+)?(?:open|launch|start|switch to|bring up)\s+(?:the\s+)?(.+?)(?:\s+app|\s+application)?(?:\s+please)?$/;

/** "open Yandex Music", "go to the GitHub website". */
const OPEN_SITE = /^(?:please\s+)?(?:open|go to|visit|take me to)\s+(?:the\s+)?(.+?)(?:\s+website|\s+site)?(?:\s+please)?$/;

/**
 * Every example phrasing, normalised, mapped to its action — or to null when
 * two actions share it, which makes it ambiguous by definition: Jev decides.
 */
let EXAMPLES: Map<string, ActionKey | null> | null = null;
function examples(): Map<string, ActionKey | null> {
  if (EXAMPLES) return EXAMPLES;
  const map = new Map<string, ActionKey | null>();
  for (const key of ACTION_KEYS) {
    const def = ACTIONS[key];
    for (const ex of def.examples) {
      const k = norm(ex);
      map.set(k, map.has(k) && map.get(k) !== key ? null : key);
    }
  }
  // Destructive actions always go through Jev and the confirmation step.
  for (const [k, key] of map) if (key && ACTIONS[key].destructive) map.set(k, null);
  EXAMPLES = map;
  return map;
}

/** "chat gpt" is "ChatGPT", "php storm" is "PhpStorm": compare without spaces. */
const squash = (s: string) => norm(s).replace(/ /g, "");

/**
 * Commands so unambiguous that asking a model adds only latency.
 *
 * Two shapes, both exact: "open <an app installed on this Mac>", and a
 * registry example said word for word ("mute", "next track", "scroll down").
 * Anything looser, anything destructive, and anything that needs a slot chosen
 * from a list goes to Jev as before. The saving is the whole round trip —
 * ~310 ms on a warm connection from here, more on a slow one.
 */
export function instantRoute(transcript: string, ctx: ActionContext): RouteDecision | null {
  const t = norm(transcript).replace(/^please /, "").replace(/ please$/, "");
  if (!t) return null;

  const opened = t.match(OPEN_APP)?.[1];
  if (opened) {
    const wanted = squash(opened);
    const app = [...ctx.runningApps, ...ctx.installedApps].find((a) => squash(a) === wanted);
    if (app) return decision("open_app", { app });
  }

  // A site known by name, with no app of exactly that name: a website, for
  // certain. Observed in real use: "open Yandex Music" opened Apple's Music,
  // and Jev, told the site's name, was still only 59% sure.
  const site = t.match(OPEN_SITE)?.[1];
  const url = site ? siteNamed(site) : null;
  if (url) return decision("open_url", { url });

  // A learned command, said the way it was taught: no round trip either.
  for (const learned of ctx.learned ?? []) {
    if (!learned.examples.some((e) => norm(e) === t)) continue;
    if (learned.parameter && !parameterValue(learned, transcript)) continue;
    return decision("run_learned", { command: learned.id });
  }

  const key = examples().get(t);
  if (!key || key === "run_learned") return null;
  const { args, missing, enums } = resolveLocalSlots(key, transcript);
  if (missing.length > 0) return null;
  // A choice the words settle by themselves — "open settings" is System
  // Settings — needs no model either; any other choice does.
  for (const [name, slot] of Object.entries(enums)) {
    const certain = certainChoice(slot, ctx);
    if (!certain) return null;
    args[name] = certain;
  }
  return decision(key, args);
}

function decision(action: ActionKey, args: Record<string, string | number>): RouteDecision {
  return {
    action, args, confidence: 1, addressed: 1, risk: 0,
    offline: false, instant: true, ms: 0, inputTokens: 0,
  };
}
