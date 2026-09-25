import type { PlatformAdapter } from "../platform/types.ts";

/**
 * The action registry's type machinery.
 *
 * This is the spine of the whole design. The registry's keys become the Jev
 * `Choice` criteria, and the SAME keys type the executor — so the model can only
 * ever return an action that exists, and an action without a handler is a
 * compile error rather than a runtime surprise.
 *
 * Note what the model is never asked to do: produce code, produce free text, or
 * produce a value that was not already in a list this code generated.
 */

export interface ActionContext {
  transcript: string;
  focusedApp: string;
  windowTitle: string;
  runningApps: string[];
  installedApps: string[];
  automations: string[];
}

/**
 * A slot whose value comes from a closed set.
 *
 * Candidates are enumerated at runtime — installed apps, open windows, the
 * user's Shortcuts — and handed to Jev as a `Choice`. The model selects; it
 * cannot invent.
 */
export interface EnumSlot {
  kind: "enum";
  describe: string;
  candidates(ctx: ActionContext): Promise<string[]> | string[];
  /** Narrow a long candidate list before asking, to keep `state` small. */
  shortlist?(ctx: ActionContext, all: string[]): string[];
  /**
   * Slots that pick from the same kind of thing share one question.
   *
   * Every action that names an application — open, quit, hide, close its
   * window — asks the same question ("which app?"), so the router asks it once,
   * in the same request as the command itself, and whichever of those actions
   * Jev picks reads the one answer. Without this, the answer was only ready if
   * the local ranker had guessed the action correctly, and every miss cost a
   * second round trip.
   */
  group?: "app";
  /** For app slots: the app must already be running (quit, hide, close). */
  requiresRunning?: boolean;
}

/**
 * A numeric slot, parsed **in code**.
 *
 * Never a Jev question: the model's own documentation is explicit that
 * arithmetic and counting are unreliable and belong in application code.
 */
export interface NumberSlot {
  kind: "number";
  describe: string;
  parse(transcript: string): number | null;
  fallback?: number;
}

/** Verbatim text lifted out of the transcript by a local pattern. */
export interface TextSlot {
  kind: "text";
  describe: string;
  extract(transcript: string): string | null;
}

export type Slot = EnumSlot | NumberSlot | TextSlot;
export type Slots = Record<string, Slot>;

export type SlotValue<S extends Slot> = S extends NumberSlot ? number : string;
export type SlotValues<S extends Slots> = { [K in keyof S]: SlotValue<S[K]> };

export interface ActionResult {
  /** Shown in the HUD and written to the activity log. */
  detail?: string;
}

export interface ActionDef<S extends Slots = Slots> {
  /** Becomes the Jev criteria description. Write it for the model, precisely. */
  describe: string;
  /** Phrasings, used by the local pre-parser and the offline matcher. */
  examples: string[];
  /**
   * Requires a spoken confirmation before running. Reserve for actions that
   * destroy work or state: emptying the Trash, shutting down, quitting.
   */
  destructive?: boolean;
  slots: S;
  run(args: SlotValues<S>, os: PlatformAdapter, ctx: ActionContext): Promise<ActionResult | void>;
}

/**
 * Declares one action, inferring its slot map so `run`'s arguments are typed
 * from that action's own slots — `open_app` gets `{ app: string }`, `set_volume`
 * gets `{ level: number }`, and a typo in either is a compile error.
 */
export function action<const S extends Slots>(def: ActionDef<S>): ActionDef<S> {
  return def;
}

// --- slot constructors -----------------------------------------------------

export function enumSlot(
  describe: string,
  candidates: EnumSlot["candidates"],
  shortlist?: EnumSlot["shortlist"],
  extra: Pick<EnumSlot, "group" | "requiresRunning"> = {},
): EnumSlot {
  return { kind: "enum", describe, candidates, ...(shortlist ? { shortlist } : {}), ...extra };
}

export function numberSlot(
  describe: string,
  parse: NumberSlot["parse"],
  fallback?: number,
): NumberSlot {
  return { kind: "number", describe, parse, ...(fallback !== undefined ? { fallback } : {}) };
}

export function textSlot(describe: string, extract: TextSlot["extract"]): TextSlot {
  return { kind: "text", describe, extract };
}
