import { ALL_BROWSERS, describeApp, isBrowser, listNames, pickBrowser, refersToBrowser, wantsAll } from "./apps.ts";
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

/**
 * Most apps offered in one question. A Choice takes at most 255 options, and
 * the list also carries "none of these" and perhaps "every open browser".
 */
const MAX_APPS = 240;

/** Largest candidate list for any other slot the transcript names nothing in. */
const MAX_FALLBACK = 80;

const APP_DESCRIBE =
  "Which application the user means. They may name it, or describe what it is for instead — " +
  "\"the browser\", \"my camera\", \"the code editor\" — so match a description against what each " +
  "application does. For \"the browser\" with none named, prefer the browser the user just used, " +
  "then one that is open now, then their default browser.";

export interface SlotQuestion {
  describe: string;
  candidates: string[];
  /** What each candidate is, where there is something worth saying. */
  notes?: Record<string, string>;
}

export interface SlotPlan {
  /** Questions to add to the request, by id. */
  questions: Map<string, SlotQuestion>;
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

const OBJECT_STOPWORDS = new Set(["the", "a", "an", "my", "please", "for", "me", "now", "app", "application"]);

/**
 * The words that name the thing: "open yandex music" → ["yandex", "music"],
 * "quit the safari app" → ["safari"].
 */
export function objectWords(transcript: string): string[] {
  return transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please\s+)?(?:open|launch|start|run|switch to|bring up|go to|quit|close|exit|hide|show|focus|activate)\s+/, "")
    .split(" ")
    .filter((w) => w && !OBJECT_STOPWORDS.has(w));
}

/**
 * Did the words name this app, and nothing more? "open yandex music"
 * contains "Music", but names Yandex Music: observed in real use, it opened
 * Apple's Music at 0.99. Every word of the object must be in the name —
 * or, squashed together, spell it ("vs code" for VSCode).
 */
export function namesExactly(transcript: string, app: string): boolean {
  const said = objectWords(transcript);
  if (said.length === 0) return false;
  const name = new Set(app.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return said.every((w) => name.has(w)) || said.join("") === squash(app);
}

/**
 * Every app worth offering: running first, since they are the likeliest
 * referent, then installed ones in the order given (most recently used first).
 */
export function appUniverse(ctx: Pick<ActionContext, "runningApps" | "installedApps">): string[] {
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
 * The app question: every app, each described.
 *
 * Offering only the apps whose names the words matched cannot work for a
 * description: "open selfie camera" names no app, and the list it used to get
 * instead — the 80 most recently used — did not include Photo Booth, which the
 * user had never opened. So the whole list goes, with what each app is for
 * and which of them are open, in front, or the default browser.
 */
export function appQuestion(ctx: ActionContext): SlotQuestion {
  const apps = appUniverse(ctx);
  const named = shortlistBy(ctx.transcript, apps, 8);
  const openBrowsers = ctx.runningApps.filter(isBrowser);
  const group = wantsAll(ctx.transcript) && openBrowsers.length > 1 ? [ALL_BROWSERS] : [];
  const candidates = [...new Set([...group, ...named, ...apps])].slice(0, MAX_APPS);

  const facts = {
    defaultBrowser: ctx.defaultBrowser,
    frontmost: ctx.focusedApp,
    lastBrowser: ctx.lastBrowser,
    running: new Set(ctx.runningApps),
  };
  const notes: Record<string, string> = {};
  for (const name of candidates) {
    const note = describeApp(name, facts);
    if (note) notes[name] = note;
  }
  if (group.length > 0) {
    notes[ALL_BROWSERS] = `All of the web browsers open now: ${listNames(openBrowsers)}. Only when the user asked for all of them.`;
  }
  return { describe: APP_DESCRIBE, candidates, notes };
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
  // Nothing matched by name — "open the settings for my screen". Send a real
  // list rather than nothing, or the answer can only be "none".
  return { candidates: all.slice(0, MAX_FALLBACK), matched: false };
}

export async function planSlots(ctx: ActionContext): Promise<SlotPlan> {
  const plan: SlotPlan = { questions: new Map(), resolved: new Map() };
  const ranked = rankActions(ctx.transcript, 5);

  // One app question, shared by open, quit, hide and close-window.
  const named = shortlistBy(ctx.transcript, appUniverse(ctx), 8);
  if (named.length > 0 || ranked.some(hasAppSlot)) {
    const only = named.length === 1 ? named[0]! : null;
    if (only && fuzzyScore(ctx.transcript, only) >= 1 && namesExactly(ctx.transcript, only) && !wantsAll(ctx.transcript)) {
      // Said verbatim, and nothing else comes close: there is nothing to ask.
      // Asking anyway is what used to cost a whole second round trip.
      plan.resolved.set(APP_QUESTION, only);
    } else {
      plan.questions.set(APP_QUESTION, appQuestion(ctx));
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
  /** The least confident answer read, when any was asked; 1 when none was. */
  confidence: number;
  /** Which slot that was. */
  unsure?: string;
  /** The runner-up to that answer: what to offer if it is too unsure. */
  alternative?: string;
}

type SlotAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number> };

/** Fill the picked action's enum slots from the plan and the answers. */
export function readSlots(
  action: ActionKey,
  answers: Record<string, SlotAnswer | undefined>,
  plan: SlotPlan,
  ctx: ActionContext,
): SlotReading {
  const out: SlotReading = { args: {}, unasked: [], unresolved: [], confidence: 1 };
  for (const [name, slot] of enumSlotsOf(action)) {
    const key = slotKey(action, name, slot);
    const asked = plan.questions.has(key);
    const answer = answers[key];
    const chosen = answer?.choice;
    const resolved = plan.resolved.get(key);
    let value = resolved ?? (chosen && chosen !== NONE ? chosen : undefined);

    if (value === undefined) {
      (asked ? out.unresolved : out.unasked).push(name);
      continue;
    }

    // "the browser" names no browser, and which one it means is a rule, not a
    // judgment: the one just used, else the one in front, else one that is
    // open, else the default. Measured: with only Chrome open, the model was
    // split 51/49 between Chrome and the default Safari for "open the browser".
    let certain = resolved !== undefined;
    if (slot.group === "app" && isBrowser(value) && refersToBrowser(ctx.transcript)) {
      const preferred = pickBrowser(ctx) ?? ctx.defaultBrowser;
      if (preferred && (!slot.requiresRunning || ctx.runningApps.includes(preferred))) {
        value = preferred;
        certain = true;
      }
    }
    // Quitting or hiding something that is not running is not a thing to do —
    // and `tell application X to quit` would launch X first, just to quit it.
    if (
      slot.requiresRunning &&
      value !== ALL_BROWSERS &&
      ctx.runningApps.length > 0 &&
      !ctx.runningApps.includes(value)
    ) {
      out.notRunning = value;
      out.unresolved.push(name);
      continue;
    }
    out.args[name] = value;

    if (!certain && answer?.confidence !== undefined && answer.confidence < out.confidence) {
      out.confidence = answer.confidence;
      out.unsure = name;
      const runnerUp = Object.entries(answer.probabilities ?? {})
        .filter(([label]) => label !== value && label !== NONE)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      out.alternative = runnerUp;
    }
  }
  return out;
}
