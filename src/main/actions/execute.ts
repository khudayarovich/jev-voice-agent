import type { PlatformAdapter } from "../platform/types.ts";
import { ACTIONS, type ActionKey } from "./registry.ts";
import type { ActionContext, ActionResult } from "./types.ts";

/**
 * Run a chosen action.
 *
 * This is the only place an action ever executes, and it dispatches on a
 * registry key — never on anything the model produced as text. There is no path
 * from a model output to a shell, a script, or an eval.
 */
export async function execute(
  key: ActionKey,
  args: Record<string, string | number>,
  os: PlatformAdapter,
  ctx: ActionContext,
): Promise<ActionResult> {
  const def = ACTIONS[key];
  // The registry is heterogeneous — each action has its own slot shape — so the
  // union cannot be narrowed here. The safety is upstream: `args` was built from
  // this action's own slot definitions, and every definition is type-checked
  // against its own `run` signature at the point it is declared.
  const run = def.run as (
    a: Record<string, string | number>,
    os: PlatformAdapter,
    ctx: ActionContext,
  ) => Promise<ActionResult | void>;

  const result = await run(args, os, ctx);
  return result ?? {};
}

/** Slot names the action needs that `args` does not supply. */
export function missingSlots(key: ActionKey, args: Record<string, unknown>): string[] {
  return Object.keys(ACTIONS[key].slots).filter((name) => args[name] === undefined);
}

/**
 * Did the user say yes?
 *
 * Confirmations are matched locally rather than asked of Jev: it is a fixed,
 * tiny vocabulary, and adding a network round trip to "yes" would be absurd.
 */
export function readConfirmation(transcript: string): "yes" | "no" | "unclear" {
  // Drop apostrophes rather than spacing them: "don't" must become "dont", not
  // "don t", or the word-boundary match below never fires.
  const t = transcript
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "unclear";
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|confirm|do it|go ahead|please do|affirmative)\b/.test(t)) {
    return "yes";
  }
  // Note the apostrophe is already stripped above, so match `dont`, not `don't`.
  if (/\b(no|nope|nah|cancel|stop|dont|do not|never mind|nevermind|abort|forget it)\b/.test(t)) {
    return "no";
  }
  return "unclear";
}
