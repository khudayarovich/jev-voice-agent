import { choice, noul, score } from "@typesafe-ai/sdk";
import { ACTIONS, ACTION_KEYS, type ActionKey, choiceCriteria } from "../actions/registry.ts";
import { fuzzyScore } from "../actions/parse.ts";
import { rankActions } from "../actions/rank.ts";
import { NONE, type RouteDecision, offlineRoute, resolveLocalSlots } from "../actions/resolve.ts";
export { offlineRoute, rankActions };
export type { RouteDecision };
import type { ActionContext, EnumSlot, NumberSlot, Slot, TextSlot } from "../actions/types.ts";
import { describeError, getClient } from "./client.ts";

/**
 * Turning a transcript into a typed action.
 *
 * The shape of this is dictated by what Jev is: a System One model that returns
 * typed decisions with calibrated probabilities, and **cannot generate text**.
 * So it is never asked to write a command — only to pick one out of the static
 * registry, and to pick slot values out of lists this code enumerated first.
 *
 * Everything the model cannot do reliably is done here instead: numbers are
 * parsed in code (its own guidance), and free-text payloads are lifted verbatim
 * out of the transcript rather than generated.
 */



/**
 * People describe things rather than naming them: "open the browser", "quit my
 * editor". Jev reads criteria literally, so an escape hatch worded "the user did
 * not name any of these" is TRUE for "the browser" — and the command was
 * refused at full confidence with no app resolved. Saying explicitly that a
 * description counts is what fixes it.
 */
function slotQuestion(describe: string): string {
  return `${describe}. The user may describe it rather than name it exactly — "the browser" means their web browser, "my editor" means their code editor. Pick the option that best fits what they meant.`;
}

const NONE_CRITERION =
  "Nothing in this list could plausibly be what the user meant, even loosely.";

const RISK_LEVELS = [
  "Harmless and instantly reversible, like changing the volume or opening an app.",
  "Changes something the user would notice but can easily undo.",
  "Closes or discards work, such as quitting an app or closing a window.",
  "Destroys data permanently or interrupts the session, such as emptying the Trash or sleeping the machine.",
] as const;


async function slotCandidates(slot: EnumSlot, ctx: ActionContext): Promise<string[]> {
  const all = await slot.candidates(ctx);
  const narrowed = slot.shortlist ? slot.shortlist(ctx, all) : all;
  if (narrowed.length) return narrowed.slice(0, 24);

  // Nothing matched by name — which is exactly the "open the browser" case. Send
  // a real list rather than the alphabetically-first 40, or the answer can only
  // be "none": running apps first, since they are the likeliest referent.
  const running = new Set(ctx.runningApps);
  const ordered = [...all].sort((a, b) => {
    const ra = running.has(a) ? 0 : 1;
    const rb = running.has(b) ? 0 : 1;
    return ra - rb || a.localeCompare(b);
  });
  return ordered.slice(0, 60);
}


export interface RouteOptions {
  /** Below this confidence the caller should ask rather than act. */
  confidenceThreshold: number;
}

export async function route(
  ctx: ActionContext,
  opts: RouteOptions,
): Promise<RouteDecision> {
  const client = getClient();
  if (!client) {
    return { ...offlineRoute(ctx), reason: "no API key configured" };
  }

  const started = Date.now();
  // Speculate for the single most likely action only.
  //
  // Extra questions are nearly free in Jev's own terms, but an enum slot carries
  // its whole candidate list, and three of those tripled the round trip: 410 ms
  // in calibration against 1.2-3.4 s in use.
  const likely = rankActions(ctx.transcript, 1);

  // Speculative fan-out: resolve enum slots for the few plausible actions in the
  // SAME request. Jev evaluates all questions in parallel, so extra questions
  // cost almost nothing, whereas a second round trip would cost another 70-500ms.
  const speculative: Record<string, ReturnType<typeof choice>> = {};
  const speculativeMap: { question: string; action: ActionKey; slot: string }[] = [];

  for (const action of likely) {
    const { enums } = resolveLocalSlots(action, ctx.transcript);
    for (const [slotName, slot] of Object.entries(enums)) {
      const candidates = await slotCandidates(slot, ctx);
      if (candidates.length === 0) continue;
      if (candidates.length === 1) continue; // nothing to decide
      const qid = `slot_${action}_${slotName}`;
      speculative[qid] = choice(slotQuestion(slot.describe), {
        ...Object.fromEntries(candidates.map((c) => [c, null])),
        [NONE]: NONE_CRITERION,
      });
      speculativeMap.push({ question: qid, action, slot: slotName });
    }
  }

  const questions = {
    command: choice(
      "Which single command is the user asking the computer to perform?",
      choiceCriteria(),
    ),
    addressed: noul(
      "The user is giving a command to their computer, rather than talking to another person or thinking out loud.",
    ),
    risk: score("How much damage would be done if this request were misunderstood?", RISK_LEVELS),
    ...speculative,
  };

  try {
    // The state is deliberately small and entirely app-built: the transcript,
    // plus a little context about what is in front of the user. Nothing that
    // came from a web page, the clipboard, or the screen ever goes in here —
    // Jev is documented as steerable by instructions injected into its state.
    const res = await client.systemOne({
      state: {
        request: ctx.transcript,
        focused_app: ctx.focusedApp || "unknown",
        window_title: ctx.windowTitle || "",
      },
      questions,
    });

    const ms = Date.now() - started;
    const answers = res.answers as Record<string, { choice?: string; confidence?: number; noul?: number; score?: number }>;
    const picked = answers.command?.choice as ActionKey | undefined;
    const confidence = answers.command?.confidence ?? 0;
    const addressed = answers.addressed?.noul ?? 1;
    const risk = answers.risk?.score ?? 0;

    if (!picked || !ACTION_KEYS.includes(picked)) {
      return {
        action: null, args: {}, confidence, addressed, risk, offline: false,
        ms, inputTokens: res.usage.input_tokens, reason: "no matching command",
      };
    }

    const { args, missing, enums } = resolveLocalSlots(picked, ctx.transcript);

    // Fill enum slots from the speculative answers where we guessed right.
    for (const slotName of Object.keys(enums)) {
      const qid = `slot_${picked}_${slotName}`;
      const answer = answers[qid];
      if (answer?.choice && answer.choice !== NONE) {
        args[slotName] = answer.choice;
      } else if (!answer) {
        missing.push(slotName);
      }
    }

    // The speculation missed: resolve the remaining slots in a second call.
    if (missing.length > 0) {
      const filled = await resolveMissingSlots(picked, missing, ctx);
      Object.assign(args, filled.args);
      if (filled.stillMissing.length > 0) {
        return {
          action: picked, args, confidence, addressed, risk, offline: false,
          ms: Date.now() - started,
          inputTokens: res.usage.input_tokens + filled.inputTokens,
          reason: `could not work out the ${filled.stillMissing.join(", ")}`,
        };
      }
      return {
        action: picked, args, confidence, addressed, risk, offline: false,
        ms: Date.now() - started,
        inputTokens: res.usage.input_tokens + filled.inputTokens,
      };
    }

    return {
      action: picked, args, confidence, addressed, risk, offline: false,
      ms, inputTokens: res.usage.input_tokens,
      ...(confidence < opts.confidenceThreshold ? { reason: "low confidence" } : {}),
    };
  } catch (err) {
    // A rate limit or a dropped connection must not take the agent down; fall
    // back to the local matcher so common commands keep working.
    const local = offlineRoute(ctx);
    return { ...local, ms: Date.now() - started, reason: describeError(err) };
  }
}

async function resolveMissingSlots(
  action: ActionKey,
  missing: string[],
  ctx: ActionContext,
): Promise<{ args: Record<string, string>; stillMissing: string[]; inputTokens: number }> {
  const client = getClient();
  const slots = ACTIONS[action].slots as Record<string, Slot>;
  const questions: Record<string, ReturnType<typeof choice>> = {};
  const wanted: string[] = [];

  for (const name of missing) {
    const slot = slots[name];
    if (!slot || slot.kind !== "enum") continue;
    const candidates = await slotCandidates(slot as EnumSlot, ctx);
    if (candidates.length === 0) continue;
    questions[name] = choice(slotQuestion(slot.describe), {
      ...Object.fromEntries(candidates.map((c) => [c, null])),
      [NONE]: NONE_CRITERION,
    });
    wanted.push(name);
  }

  if (!client || wanted.length === 0) {
    return { args: {}, stillMissing: missing, inputTokens: 0 };
  }

  const res = await client.systemOne({
    state: { request: ctx.transcript },
    questions,
  });
  const args: Record<string, string> = {};
  const stillMissing: string[] = [];
  for (const name of wanted) {
    const answer = (res.answers as Record<string, { choice?: string }>)[name];
    if (answer?.choice && answer.choice !== NONE) args[name] = answer.choice;
    else stillMissing.push(name);
  }
  return { args, stillMissing, inputTokens: res.usage.input_tokens };
}
