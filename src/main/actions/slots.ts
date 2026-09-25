import { fuzzyScore, shortlistBy } from "./parse.ts";
import { rankActions } from "./rank.ts";
import { ACTIONS, type ActionKey } from "./registry.ts";
import { NONE } from "./resolve.ts";
import type { ActionContext, EnumSlot, Slot } from "./types.ts";

/**
 * Deciding which slot questions go into the routing request.
 *
 * Jev evaluates every question in a request in parallel, and measured against
 * the live API an extra question costs nothing noticeable — the same request
 * with a 60-option app question came back in 319 ms against 318 ms without it.
 * A second round trip, on the other hand, costs a full ~300 ms more. So the plan
 * is to ask, in the one request that picks the command, everything the likely
 * commands could need.
 *
 * Kept free of Electron and the network so it can be tested directly.
 */

/** The shared question every app-naming action reads its answer from. */
export const APP_QUESTION = "app";

/** Largest candidate list sent when the transcript names no app at all. */
const MAX_APP_FALLBACK = 80;

export interface SlotPlan {
  /** Questions to add to the request, by id. */
  questions: Map<string, { describe: string; candidates: string[] }>;
  /** Values certain enough not to ask about, by the same ids. */
  resolved: Map<string, string>;
}

export function slotKey(action: ActionKey, slotName: string, slot: EnumSlot): string {
  return slot.group === "app" ? APP_QUESTION : `slot_${action}_${slotName}`;
}

function enumSlotsOf(action: ActionKey): [string, EnumSlot][] {
  return Object.entries(ACTIONS[action].slots as Record<string, Slot>).filter(
    (e): e is [string, EnumSlot] => e[1].kind === "enum",
  );
}

const hasAppSlot = (action: ActionKey) => enumSlotsOf(action).some(([, s]) => s.group === "app");

/**
 * Every app worth offering: running first, since they are the likeliest
 * referent, then installed ones in the order given (most recently used first).
 */
export function appUniverse(ctx: ActionContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...ctx.runningApps, ...ctx.installedApps]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Candidates for one enum slot, narrowed by the transcript where possible.
 * `matched` says whether the transcript actually named any of them.
 */
export async function slotCandidates(
  slot: EnumSlot,
  ctx: ActionContext,
): Promise<{ candidates: string[]; matched: boolean }> {
  const all = await slot.candidates(ctx);
  const narrowed = slot.shortlist ? slot.shortlist(ctx, all) : all;
  if (narrowed.length) return { candidates: narrowed.slice(0, 24), matched: Boolean(slot.shortlist) };
  // Nothing matched by name — the "open the browser" case. Send a real list
  // rather than nothing, or the answer can only be "none".
  return { candidates: all.slice(0, MAX_APP_FALLBACK), matched: false };
}

export async function planSlots(ctx: ActionContext): Promise<SlotPlan> {
  const plan: SlotPlan = { questions: new Map(), resolved: new Map() };
  const ranked = rankActions(ctx.transcript, 5);

  // One app question, shared by open, quit, hide and close-window.
  const apps = appUniverse(ctx);
  const named = shortlistBy(ctx.transcript, apps, 8);
  if (named.length > 0 || ranked.some(hasAppSlot)) {
    const only = named.length === 1 ? named[0]! : null;
    if (only && fuzzyScore(ctx.transcript, only) >= 1) {
      // Said verbatim, and nothing else comes close: there is nothing to ask.
      // Asking anyway is what used to cost a whole second round trip.
      plan.resolved.set(APP_QUESTION, only);
    } else {
      plan.questions.set(APP_QUESTION, {
        describe: "Which application the user is referring to",
        candidates: named.length > 0 ? named : apps.slice(0, MAX_APP_FALLBACK),
      });
    }
  }

  // Everything else — left/right, which Shortcut — for the likely actions.
  for (const action of ranked) {
    for (const [name, slot] of enumSlotsOf(action)) {
      if (slot.group === "app") continue;
      const key = slotKey(action, name, slot);
      if (plan.questions.has(key) || plan.resolved.has(key)) continue;
      const { candidates, matched } = await slotCandidates(slot, ctx);
      if (candidates.length === 0) continue;
      // One candidate the user actually named ("snap this LEFT") is the answer.
      // One candidate they did not name is still a question: "run my morning
      // routine" must not run the only Shortcut there is just because it exists.
      if (candidates.length === 1 && matched) plan.resolved.set(key, candidates[0]!);
      else plan.questions.set(key, { describe: slot.describe, candidates });
    }
  }
  return plan;
}

export interface SlotReading {
  args: Record<string, string>;
  /** Slots nobody asked about — worth a second, targeted request. */
  unasked: string[];
  /** Slots asked about where the answer was "none of these". */
  unresolved: string[];
  /** An app the action needs running that is not, e.g. "quit Photoshop". */
  notRunning?: string;
}

/** Fill the picked action's enum slots from the plan and the answers. */
export function readSlots(
  action: ActionKey,
  answers: Record<string, { choice?: string } | undefined>,
  plan: SlotPlan,
  ctx: ActionContext,
): SlotReading {
  const out: SlotReading = { args: {}, unasked: [], unresolved: [] };
  for (const [name, slot] of enumSlotsOf(action)) {
    const key = slotKey(action, name, slot);
    const asked = plan.questions.has(key);
    const answer = answers[key]?.choice;
    const value = plan.resolved.get(key) ?? (answer && answer !== NONE ? answer : undefined);

    if (value === undefined) {
      (asked ? out.unresolved : out.unasked).push(name);
      continue;
    }
    // Quitting or hiding something that is not running is not a thing to do —
    // and `tell application X to quit` would launch X first, just to quit it.
    if (slot.requiresRunning && ctx.runningApps.length > 0 && !ctx.runningApps.includes(value)) {
      out.notRunning = value;
      out.unresolved.push(name);
      continue;
    }
    out.args[name] = value;
  }
  return out;
}
