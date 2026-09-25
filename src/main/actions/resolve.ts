import { fuzzyScore, namesExactly, saysPlainly } from "./parse.ts";
import { ACTIONS, type ActionKey } from "./registry.ts";
import { rankActions } from "./rank.ts";
import type { ActionContext, EnumSlot, NumberSlot, Slot, TextSlot } from "./types.ts";

/**
 * Slot resolution and the offline matcher.
 *
 * Deliberately free of any Electron or network dependency: this is the layer
 * that decides what a command means, so it is the layer most worth testing
 * hermetically.
 */

/** Marks "none of these candidates is right" in a slot Choice. */
export const NONE = "none";

/** What a route resolved to, whether by Jev or locally. */
export interface RouteDecision {
  action: ActionKey | null;
  args: Record<string, string | number>;
  confidence: number;
  addressed: number;
  risk: number;
  offline: boolean;
  /** Decided on this Mac by an exact match, without asking Jev. */
  instant?: boolean;
  /** Jev found no command for it: something the agent could learn. */
  unknown?: boolean;
  /** Jev's confidence in the least certain slot it chose, e.g. which app. */
  slotConfidence?: number;
  /** Which slot that was, e.g. "app". */
  unsureSlot?: string;
  /** The runner-up for that slot, to offer when it was not sure. */
  alternative?: string;
  ms: number;
  inputTokens: number;
  reason?: string;
}

/** Resolve everything that does NOT need the model. */
export function resolveLocalSlots(
  action: ActionKey,
  transcript: string,
): { args: Record<string, string | number>; missing: string[]; enums: Record<string, EnumSlot> } {
  const args: Record<string, string | number> = {};
  const missing: string[] = [];
  const enums: Record<string, EnumSlot> = {};

  for (const [name, slot] of Object.entries(ACTIONS[action].slots as Record<string, Slot>)) {
    if (slot.kind === "number") {
      const n = (slot as NumberSlot).parse(transcript);
      if (n !== null) args[name] = n;
      else if ((slot as NumberSlot).fallback !== undefined) args[name] = (slot as NumberSlot).fallback!;
      else missing.push(name);
    } else if (slot.kind === "text") {
      const v = (slot as TextSlot).extract(transcript);
      if (v) args[name] = v;
      else missing.push(name);
    } else {
      enums[name] = slot as EnumSlot;
    }
  }
  return { args, missing, enums };
}

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

/**
 * Deterministic matcher used when Jev is unreachable, rate limited, or
 * unconfigured.
 *
 * Far blunter than the model, so it acts only on plain evidence: an example
 * phrasing said outright, or a command whose verb was said and whose every
 * slot the words fill. Anything less comes back below any threshold that acts,
 * because a keyword guess was not enough: during a real outage, "go to
 * battery" came out as sleep, and "show hidden files in Finder" opened Mission
 * Control. It also keeps the routing tests hermetic.
 */
export function offlineRoute(ctx: ActionContext): RouteDecision {
  const attempts = rankActions(ctx.transcript, 4).map((key) => offlineAttempt(key, ctx));
  const plain = attempts.find((a) => a.plain);
  const best = plain ?? attempts[0];
  if (!best) {
    return {
      action: null, args: {}, confidence: 0, addressed: 1, risk: 0,
      offline: true, ms: 0, inputTokens: 0, reason: "no local match",
    };
  }
  const reason = best.missing.length ? `could not work out the ${best.missing.join(", ")}` : plain ? null : "not sure without Jev";
  return {
    action: best.key,
    args: best.args,
    confidence: plain ? 0.62 : 0.3,
    addressed: 1,
    risk: ACTIONS[best.key].destructive ? 3 : 0,
    offline: true,
    ms: 0,
    inputTokens: 0,
    ...(reason ? { reason } : {}),
  };
}

const LEAD_INS = new Set(["please", "can", "could", "would", "you", "hey", "just", "now", "ok", "okay"]);

/** The word that says what to do: "can you open Safari" → "open". */
function verbOf(s: string): string | null {
  return s.toLowerCase().split(/[^a-z0-9]+/).find((w) => w && !LEAD_INS.has(w)) ?? null;
}

/** One command, read from the words alone: its arguments, and whether they say it plainly. */
function offlineAttempt(key: ActionKey, ctx: ActionContext) {
  const { args, missing, enums } = resolveLocalSlots(key, ctx.transcript);
  const slots = Object.entries(ACTIONS[key].slots as Record<string, Slot>);

  // Did the words supply any of it, or only defaults? "go to battery" fills
  // scroll_down's page count, with the one page it has when none is said: a
  // number is the words' only if, without them, it would differ.
  let named = slots.some(([name, slot]) =>
    name in args &&
    (slot.kind === "text" ||
      (slot.kind === "number" && (slot as NumberSlot).parse(ctx.transcript) !== (slot as NumberSlot).parse(""))));

  // Resolve enum slots by direct mention only — no guessing.
  for (const [name, slot] of Object.entries(enums)) {
    const certain = certainChoice(slot, ctx);
    if (certain) {
      args[name] = certain;
      // The words chose it only if, without them, the choice would differ:
      // with no page named, the settings page is System Settings anyway.
      if (certainChoice(slot, { ...ctx, transcript: "" }) !== certain) named = true;
      continue;
    }
    const all = slot.shortlist
      ? slot.shortlist(ctx, syncCandidates(slot, ctx))
      : syncCandidates(slot, ctx);
    const best = all
      .map((c) => ({ c, s: fuzzyScore(ctx.transcript, c) }))
      .sort((a, b) => b.s - a.s)[0];
    // An app named by all the words: "open Yandex Music" does not name Music.
    if (best && best.s >= 0.9 && (slot.group !== "app" || namesExactly(ctx.transcript, best.c))) {
      args[name] = best.c;
      named = true;
    } else missing.push(name);
  }

  const { examples } = ACTIONS[key];
  const verb = verbOf(ctx.transcript);
  const saidOutright = examples.some((ex) => saysPlainly(ctx.transcript, ex));
  const saidWithItsVerb = named && examples.some((ex) => verbOf(ex) === verb);
  return { key, args, missing, plain: missing.length === 0 && (saidOutright || saidWithItsVerb) };
}

/**
 * The one value an enum slot's own shortlist leaves — "open settings" leaves
 * System Settings, "snap this left" leaves left — when the words themselves
 * decide it. Not for apps, whose shortlist is a fuzzy guess at a name.
 */
export function certainChoice(slot: EnumSlot, ctx: ActionContext): string | null {
  if (slot.group === "app" || !slot.shortlist) return null;
  const listed = slot.shortlist(ctx, syncCandidates(slot, ctx));
  return listed.length === 1 ? listed[0]! : null;
}

/** Enum candidates that are already resolved, for the synchronous offline path. */
function syncCandidates(slot: EnumSlot, ctx: ActionContext): string[] {
  const out = slot.candidates(ctx);
  return Array.isArray(out) ? out : [];
}

export { rankActions };
