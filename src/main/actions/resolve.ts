import { fuzzyScore } from "./parse.ts";
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
 * Far blunter than the model — it matches example phrasings and nothing else —
 * but it keeps the common commands working with no network at all, and it makes
 * the routing tests hermetic.
 */
export function offlineRoute(ctx: ActionContext): RouteDecision {
  const ranked = rankActions(ctx.transcript, 1);
  const picked = ranked[0];
  if (!picked) {
    return {
      action: null, args: {}, confidence: 0, addressed: 1, risk: 0,
      offline: true, ms: 0, inputTokens: 0, reason: "no local match",
    };
  }

  const { args, missing, enums } = resolveLocalSlots(picked, ctx.transcript);

  // Resolve enum slots by direct mention only — no guessing.
  for (const [name, slot] of Object.entries(enums)) {
    const all = slot.shortlist
      ? slot.shortlist(ctx, syncCandidates(slot, ctx))
      : syncCandidates(slot, ctx);
    const best = all
      .map((c) => ({ c, s: fuzzyScore(ctx.transcript, c) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.9) args[name] = best.c;
    else missing.push(name);
  }

  const confidence = missing.length === 0 ? 0.62 : 0.3;
  return {
    action: picked,
    args,
    confidence,
    addressed: 1,
    risk: ACTIONS[picked].destructive ? 3 : 0,
    offline: true,
    ms: 0,
    inputTokens: 0,
    ...(missing.length ? { reason: `could not work out the ${missing.join(", ")}` } : {}),
  };
}

/** Enum candidates that are already resolved, for the synchronous offline path. */
function syncCandidates(slot: EnumSlot, ctx: ActionContext): string[] {
  const out = slot.candidates(ctx);
  return Array.isArray(out) ? out : [];
}

export { rankActions };
