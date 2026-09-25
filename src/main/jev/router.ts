import { choice, noul, score } from "@typesafe-ai/sdk";
import { ALL_BROWSERS } from "../actions/apps.ts";
import { parameterValue } from "../learning/lesson.ts";
import {
  ACTIONS,
  ACTION_KEYS,
  type ActionKey,
  LEARNED_PREFIX,
  UNKNOWN_TASK,
  choiceCriteria,
} from "../actions/registry.ts";
import { rankActions } from "../actions/rank.ts";
import { NONE, type RouteDecision, offlineRoute, resolveLocalSlots } from "../actions/resolve.ts";
import { type SlotQuestion, appQuestion, planSlots, readSlots, slotCandidates } from "../actions/slots.ts";
import type { ActionContext, EnumSlot, Slot } from "../actions/types.ts";
import { describeError, getClient } from "./client.ts";
export { offlineRoute, rankActions };
export type { RouteDecision };

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
 *
 * Latency: one request answers everything. Measured against the live API, the
 * round trip is ~310 ms on a warm connection whether it carries three questions
 * or four, so the command, the addressee check, the risk and the slot answers
 * all travel together. A second request is only made when Jev picks a command
 * nobody predicted AND that command needs a slot nobody asked about.
 */

/**
 * People describe things rather than naming them: "open the browser", "quit my
 * editor". Jev reads criteria literally, so an escape hatch worded "the user did
 * not name any of these" is TRUE for "the browser" — and the command was
 * refused at full confidence with no app resolved. Saying explicitly that a
 * description counts is what fixes it.
 */
function slotQuestion(describe: string): string {
  const sentence = /[.!?]$/.test(describe) ? describe : `${describe}.`;
  return `${sentence} The user may describe it rather than name it exactly. Pick the option that best fits what they meant.`;
}

const NONE_CRITERION =
  "Nothing in this list could plausibly be what the user meant, even loosely.";

const RISK_LEVELS = [
  "Harmless and instantly reversible, like changing the volume or opening an app.",
  "Changes something the user would notice but can easily undo.",
  "Closes or discards work, such as quitting an app or closing a window.",
  "Destroys data permanently or interrupts the session, such as emptying the Trash or sleeping the machine.",
] as const;

/** A slot question as a Choice: each candidate, described where it helps. */
function slotChoice(q: SlotQuestion) {
  return choice(slotQuestion(q.describe), {
    ...Object.fromEntries(q.candidates.map((c) => [c, q.notes?.[c] ?? null])),
    [NONE]: NONE_CRITERION,
  });
}

/**
 * What the request is judged against: the words, and a little app-built
 * context. `recent_actions` is what this conversation has already done — so
 * "close it" or "search for cats there" has something to refer to.
 */
function stateFor(ctx: ActionContext) {
  return {
    request: ctx.transcript,
    focused_app: ctx.focusedApp || "unknown",
    window_title: ctx.windowTitle || "",
    ...(ctx.recent?.length ? { recent_actions: ctx.recent } : {}),
  };
}

export interface RouteOptions {
  /** Below this confidence the caller should ask rather than act. */
  confidenceThreshold: number;
  /** Use the local matcher when Jev cannot be reached. */
  offlineFallback: boolean;
  /** Cancels the request, e.g. when the user kept talking. */
  signal?: AbortSignal;
}

type Answers = Record<
  string,
  { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number; score?: number }
>;

export async function route(ctx: ActionContext, opts: RouteOptions): Promise<RouteDecision> {
  const client = getClient();
  if (!client) return fallback(ctx, opts, "no API key configured", Date.now());

  const started = Date.now();
  const plan = await planSlots(ctx);

  const questions = {
    command: choice(
      "Which single command is the user asking the computer to perform?",
      choiceCriteria(ctx.learned ?? []),
    ),
    addressed: noul(
      "The user is giving a command to their computer, rather than talking to another person or thinking out loud.",
    ),
    risk: score("How much damage would be done if this request were misunderstood?", RISK_LEVELS),
    ...Object.fromEntries([...plan.questions].map(([id, q]) => [id, slotChoice(q)])),
  };

  try {
    // The state is deliberately small and entirely app-built: the transcript,
    // plus a little context about what is in front of the user. Nothing that
    // came from a web page, the clipboard, or the screen ever goes in here —
    // Jev is documented as steerable by instructions injected into its state.
    const res = await client.systemOne(
      { state: stateFor(ctx), questions },
      opts.signal ? { signal: opts.signal } : {},
    );

    const answers = res.answers as Answers;
    const choiceMade = answers.command?.choice;
    const picked = choiceMade as ActionKey | undefined;
    const confidence = answers.command?.confidence ?? 0;
    const addressed = answers.addressed?.noul ?? 1;
    const risk = answers.risk?.score ?? 0;
    let inputTokens = res.usage.input_tokens;
    const ms = () => Date.now() - started;

    // Nothing fits: a task the agent could learn.
    if (choiceMade === UNKNOWN_TASK) {
      return {
        action: null, args: {}, confidence, addressed, risk, offline: false,
        ms: ms(), inputTokens, unknown: true, reason: "no command for that yet",
      };
    }

    // One the agent learned earlier: no second opinion needed.
    if (choiceMade?.startsWith(LEARNED_PREFIX)) {
      const id = choiceMade.slice(LEARNED_PREFIX.length);
      const learned = ctx.learned?.find((c) => c.id === id);
      const missing = learned?.parameter && !parameterValue(learned, ctx.transcript);
      const reason = !learned
        ? "no matching command"
        : missing
          ? `could not work out the ${learned.parameter!.name.replace(/_/g, " ")}`
          : confidence < opts.confidenceThreshold
            ? "low confidence"
            : undefined;
      return {
        action: learned ? "run_learned" : null, args: learned ? { command: id } : {}, confidence, addressed, risk,
        offline: false, ms: ms(), inputTokens, ...(reason ? { reason } : {}),
      };
    }

    if (!picked || !ACTION_KEYS.includes(picked) || picked === "run_learned") {
      return {
        action: null, args: {}, confidence, addressed, risk, offline: false,
        ms: Date.now() - started, inputTokens, reason: "no matching command",
      };
    }

    const local = resolveLocalSlots(picked, ctx.transcript);
    const args: Record<string, string | number> = { ...local.args };
    const slots = readSlots(picked, answers, plan, ctx);
    Object.assign(args, slots.args);
    const missing = [...local.missing, ...slots.unresolved];

    // Jev picked a command nobody predicted, and it needs a slot nobody asked
    // about. Rare now that the app question is shared; ask just that.
    if (slots.unasked.length > 0) {
      const filled = await resolveMissingSlots(picked, slots.unasked, ctx, opts.signal);
      Object.assign(args, filled.args);
      missing.push(...filled.stillMissing);
      inputTokens += filled.inputTokens;
    }

    const reason = slots.notRunning
      ? `${slots.notRunning} isn't running`
      : missing.length > 0
        ? `could not work out the ${missing.join(", ")}`
        : confidence < opts.confidenceThreshold
          ? "low confidence"
          : undefined;

    return {
      action: picked, args, confidence, addressed, risk, offline: false,
      ms: Date.now() - started, inputTokens,
      ...(slots.confidence < 1 ? { slotConfidence: slots.confidence, unsureSlot: slots.unsure } : {}),
      ...(slots.alternative ? { alternative: slots.alternative } : {}),
      ...(reason ? { reason } : {}),
    };
  } catch (err) {
    // The caller gave up on this request (the user kept talking): report that
    // rather than dressing it up as a network failure.
    if (opts.signal?.aborted) throw err;
    // A rate limit or a dropped connection must not take the agent down; fall
    // back to the local matcher so common commands keep working.
    return fallback(ctx, opts, describeError(err), started);
  }
}

/** The local matcher, if the user allows it; otherwise an honest "no". */
function fallback(ctx: ActionContext, opts: RouteOptions, reason: string, started: number): RouteDecision {
  const ms = Date.now() - started;
  if (!opts.offlineFallback) {
    return {
      action: null, args: {}, confidence: 0, addressed: 1, risk: 0,
      offline: true, ms, inputTokens: 0, reason,
    };
  }
  return { ...offlineRoute(ctx), ms, reason };
}

async function resolveMissingSlots(
  action: ActionKey,
  missing: string[],
  ctx: ActionContext,
  signal: AbortSignal | undefined,
): Promise<{ args: Record<string, string>; stillMissing: string[]; inputTokens: number }> {
  const client = getClient();
  const slots = ACTIONS[action].slots as Record<string, Slot>;
  const questions: Record<string, ReturnType<typeof choice>> = {};

  for (const name of missing) {
    const slot = slots[name];
    if (!slot || slot.kind !== "enum") continue;
    const enumSlot = slot as EnumSlot;
    if (enumSlot.group === "app") {
      questions[name] = slotChoice(appQuestion(ctx));
      continue;
    }
    const { candidates } = await slotCandidates(enumSlot, ctx);
    if (candidates.length === 0) continue;
    questions[name] = slotChoice({ describe: enumSlot.describe, candidates });
  }

  if (!client || Object.keys(questions).length === 0) {
    return { args: {}, stillMissing: missing, inputTokens: 0 };
  }

  const res = await client.systemOne({ state: stateFor(ctx), questions }, signal ? { signal } : {});
  const answers = res.answers as Answers;
  const args: Record<string, string> = {};
  const stillMissing: string[] = [];
  for (const name of missing) {
    const answer = answers[name]?.choice;
    const slot = slots[name] as EnumSlot | undefined;
    // As in readSlots: never quit or hide an app that is not running.
    const idle = slot?.requiresRunning && answer !== ALL_BROWSERS && ctx.runningApps.length > 0 &&
      !ctx.runningApps.includes(answer ?? "");
    if (answer && answer !== NONE && !idle) args[name] = answer;
    else stillMissing.push(name);
  }
  return { args, stillMissing, inputTokens: res.usage.input_tokens };
}
