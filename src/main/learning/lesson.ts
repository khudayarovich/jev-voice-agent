import { afterPhrase } from "../actions/parse.ts";

/**
 * Commands the agent learns.
 *
 * When Jev finds no command for a request, a language model (GPT-6 Luna, over
 * OpenRouter) is asked to design one. What it may design is the crux of the
 * whole feature: it composes a command out of the steps below and nothing
 * else — commands the agent already has, a keyboard shortcut, a menu item, a
 * web address, text to type, a click on something on screen, a pause. It
 * never writes a script or a shell command, and nothing it returns runs until
 * it has been checked here, shown to the user, and agreed to once.
 *
 * Once learned, a command is Jev's to choose like any other, and the model is
 * never asked about it again.
 *
 * Pure: no Electron, no network, no registry — so it is tested directly.
 */

/** One free-text value a learned command takes: "search Amazon for {item}". */
export interface LearnedParameter {
  name: string;
  describe: string;
  /** Phrases the value follows: "search amazon for", "find on amazon". */
  leads: string[];
}

export type LearnedStep =
  /** A command the agent already has, with its arguments as said. */
  | { do: "action"; action: string; args: Record<string, string> }
  /** A keyboard shortcut, in the app in front or a named one. */
  | { do: "keys"; combo: string; app?: string }
  /** A menu item by its path, e.g. ["File", "New Folder"]. */
  | { do: "menu"; path: string[]; app?: string }
  | { do: "open_url"; url: string }
  | { do: "type"; text: string }
  /** Something on screen, by the words on it. */
  | { do: "click"; target: string }
  | { do: "wait"; ms: number };

export interface LearnedCommand {
  /** snake_case, unique among learned commands. */
  id: string;
  title: string;
  /** What Jev reads to decide whether a request is this command. */
  describe: string;
  examples: string[];
  parameter: LearnedParameter | null;
  steps: LearnedStep[];
  /** Ask every time before running: a step quits, deletes, sends or the like. */
  confirm: boolean;
  /** The request that taught it, in the user's words. */
  learnedFrom: string;
  learnedAt: string;
  model: string;
  uses: number;
}

/** The value that stands for the parameter in a step's text. */
export const PARAM = "{value}";

/**
 * Apps where typed text becomes a command that runs: shells, and the script
 * editors. "Open Terminal, type rm -rf ~, press Return" is made only of
 * allowed steps, and is exactly the script this design exists to rule out. So
 * a lesson may not involve one of these, and a learned command does not type
 * or press keys while one is in front (see run.ts).
 */
const SCRIPT_RUNNERS = new Set([
  "terminal", "iterm", "iterm2", "warp", "ghostty", "alacritty", "kitty", "wezterm", "hyper",
  "tabby", "termius", "script editor", "automator",
]);

export function isScriptRunner(app: string): boolean {
  return SCRIPT_RUNNERS.has(app.trim().toLowerCase());
}

const MAX_STEPS = 12;
const MAX_TEXT = 500;

// ---------------------------------------------------------------------------
// What the model returns
// ---------------------------------------------------------------------------

/**
 * The model's answer, as a strict JSON schema: every field present, optional
 * ones as null, so structured output can enforce the shape before it arrives.
 */
export const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["possible", "reason", "command"],
  properties: {
    possible: { type: "boolean" },
    reason: { type: "string" },
    command: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "describe", "examples", "parameter", "steps"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            describe: { type: "string" },
            examples: { type: "array", items: { type: "string" } },
            parameter: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "describe", "leads"],
                  properties: {
                    name: { type: "string" },
                    describe: { type: "string" },
                    leads: { type: "array", items: { type: "string" } },
                  },
                },
              ],
            },
            steps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["do", "action", "args", "app", "combo", "path", "url", "text", "target", "ms"],
                properties: {
                  do: { type: "string", enum: ["action", "keys", "menu", "open_url", "type", "click", "wait"] },
                  action: { type: ["string", "null"] },
                  args: {
                    anyOf: [
                      { type: "null" },
                      {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["name", "value"],
                          properties: { name: { type: "string" }, value: { type: "string" } },
                        },
                      },
                    ],
                  },
                  app: { type: ["string", "null"] },
                  combo: { type: ["string", "null"] },
                  path: { anyOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
                  url: { type: ["string", "null"] },
                  text: { type: ["string", "null"] },
                  target: { type: ["string", "null"] },
                  ms: { type: ["integer", "null"] },
                },
              },
            },
          },
        },
      ],
    },
  },
} as const;

interface RawStep {
  do?: unknown;
  action?: unknown;
  args?: unknown;
  app?: unknown;
  combo?: unknown;
  path?: unknown;
  url?: unknown;
  text?: unknown;
  target?: unknown;
  ms?: unknown;
}

// ---------------------------------------------------------------------------
// Checking it
// ---------------------------------------------------------------------------

/** What only the caller knows: the agent's own commands, and the apps here. */
export interface LessonChecks {
  /** Null when the command exists and its arguments fit it; else why not. */
  checkAction(action: string, args: Record<string, string>): string | null;
  /** Whether an existing command asks before running (quit, empty the Trash). */
  isDestructive(action: string): boolean;
  /** Installed and running apps: a step may only name one of these. */
  apps: string[];
  /** Ids already taken, by commands built in or learned. */
  takenIds: Set<string>;
}

/** Words on a menu item, a button or a shortcut's purpose that make it ask first. */
const DESTRUCTIVE =
  /\b(delete|remove|erase|trash|discard|uninstall|format|send|submit|pay|buy|purchase|order|checkout|sign out|log out|logout|unsubscribe|deactivate|reset|empty|quit|close all|restart|shut ?down|force)\b/i;

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "cmd", command: "cmd", "⌘": "cmd",
  shift: "shift", "⇧": "shift",
  option: "option", opt: "option", alt: "option", "⌥": "option",
  ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
  fn: "fn",
};

const NAMED_KEYS = new Set([
  "return", "enter", "tab", "space", "delete", "escape", "esc", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

const MODIFIER_ORDER = ["ctrl", "option", "shift", "cmd", "fn"];

/** Keys written as words. */
const KEY_WORDS: Record<string, string> = {
  esc: "escape", minus: "-", hyphen: "-", plus: "=", equals: "=", comma: ",", period: ".",
  dot: ".", slash: "/", backslash: "\\", semicolon: ";", quote: "'", backtick: "`",
};

/**
 * "Command+Shift+N", "cmd-shift-n" or "⌘⇧N" → "shift+cmd+n", or null when it
 * is not a key combination. "+" is the separator where there is one, so
 * "cmd+-" (zoom out) keeps its minus.
 */
export function normalizeCombo(combo: string): string | null {
  let s = combo
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/⌘/g, "cmd+").replace(/⇧/g, "shift+").replace(/⌥/g, "option+").replace(/⌃/g, "ctrl+");
  let key = "";
  if (s.endsWith("++")) {
    key = "=";
    s = s.slice(0, -2);
  } else if (s.endsWith("+-")) {
    key = "-";
    s = s.slice(0, -2);
  }
  const parts = (s.includes("+") ? s.split("+") : s.split("-")).filter(Boolean);
  if (!key) key = parts.pop() ?? "";
  if (!key) return null;
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p];
    if (!m) return null;
    mods.add(m);
  }
  const k = KEY_WORDS[key] ?? key;
  if (!(NAMED_KEYS.has(k) || /^[a-z0-9`\-=[\];',./\\]$/.test(k))) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), k].join("+");
}

/**
 * Shortcuts never learned: they quit, log out, force-quit, or delete — too
 * much to hang on a phrase the recogniser might one day mishear. (Quitting has
 * a command of its own, which asks first.) Kept in normalized form.
 */
const FORBIDDEN_COMBOS = new Set(
  [
    "cmd+q", "cmd+shift+q", "cmd+option+shift+q", "cmd+option+escape",
    "cmd+delete", "cmd+shift+delete", "cmd+option+delete", "cmd+option+shift+delete",
  ].map((c) => normalizeCombo(c)!),
);

const isHttpUrl = (u: string) => {
  try {
    const url = new URL(u.replaceAll(PARAM, "x"));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function toStep(raw: RawStep, checks: LessonChecks): { step: LearnedStep; destructive: boolean } | string {
  const app = str(raw.app);
  if (app && !checks.apps.includes(app)) return `"${app}" is not an app on this Mac`;
  if (app && isScriptRunner(app)) return `commands for ${app} are not something I learn`;
  switch (raw.do) {
    case "action": {
      const action = str(raw.action);
      if (!action) return "an action step names no command";
      if (action === "run_learned") return "a learned command cannot run another";
      const args: Record<string, string> = {};
      if (Array.isArray(raw.args)) {
        for (const a of raw.args as { name?: unknown; value?: unknown }[]) {
          const name = str(a?.name);
          const value = typeof a?.value === "string" ? a.value : null;
          if (name && value !== null) args[name] = value;
        }
      }
      const problem = checks.checkAction(action, args);
      if (problem) return problem;
      if (Object.values(args).some((v) => isScriptRunner(v))) return `commands for ${Object.values(args).find(isScriptRunner)} are not something I learn`;
      return { step: { do: "action", action, args }, destructive: checks.isDestructive(action) };
    }
    case "keys": {
      const combo = normalizeCombo(str(raw.combo) ?? "");
      if (!combo) return `"${String(raw.combo)}" is not a key combination`;
      if (FORBIDDEN_COMBOS.has(combo)) return `${combo} is not a shortcut to learn`;
      return { step: { do: "keys", combo, ...(app ? { app } : {}) }, destructive: false };
    }
    case "menu": {
      const path = Array.isArray(raw.path) ? (raw.path as unknown[]).map(str).filter((p): p is string => Boolean(p)) : [];
      if (path.length < 2 || path.length > 3 || path.some((p) => p.length > 80)) return "a menu step needs a menu and an item";
      return { step: { do: "menu", path, ...(app ? { app } : {}) }, destructive: path.some((p) => DESTRUCTIVE.test(p)) };
    }
    case "open_url": {
      const url = str(raw.url);
      if (!url || !isHttpUrl(url)) return "a web step needs an http or https address";
      return { step: { do: "open_url", url }, destructive: false };
    }
    case "type": {
      const text = typeof raw.text === "string" ? raw.text : "";
      if (!text || text.length > MAX_TEXT) return "a typing step needs text";
      return { step: { do: "type", text }, destructive: false };
    }
    case "click": {
      const target = str(raw.target);
      if (!target || target.length > 80) return "a click step needs the words on what to click";
      return { step: { do: "click", target }, destructive: DESTRUCTIVE.test(target) };
    }
    case "wait": {
      const ms = typeof raw.ms === "number" ? Math.round(raw.ms) : NaN;
      if (!(ms > 0 && ms <= 3000)) return "a pause must be between 0 and 3 seconds";
      return { step: { do: "wait", ms }, destructive: false };
    }
    default:
      return `"${String(raw.do)}" is not a step`;
  }
}

const snake = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

export type Checked = { ok: true; command: LearnedCommand } | { ok: false; reason: string };

/**
 * Turn what the model sent into a command, or say why it will not do. Every
 * step is checked against what exists on this Mac, and anything destructive
 * marks the whole command to ask each time.
 */
export function checkLesson(
  answer: unknown,
  checks: LessonChecks,
  about: { request: string; model: string; now?: Date },
): Checked {
  const a = answer as { possible?: unknown; reason?: unknown; command?: Record<string, unknown> | null } | null;
  if (!a || typeof a !== "object") return { ok: false, reason: "The answer was not understood" };
  if (a.possible !== true || !a.command) {
    return { ok: false, reason: str(a.reason) ?? "It is not something I can learn" };
  }
  const c = a.command;
  const title = str(c.title);
  const describe = str(c.describe);
  if (!title || !describe) return { ok: false, reason: "The new command had no name" };

  let id = snake(str(c.id) ?? title) || "learned";
  for (let n = 2; checks.takenIds.has(id); n++) id = `${snake(str(c.id) ?? title)}_${n}`;

  const examples = (Array.isArray(c.examples) ? (c.examples as unknown[]) : [])
    .map(str)
    .filter((e): e is string => Boolean(e))
    .slice(0, 8);
  if (!examples.some((e) => e.toLowerCase() === about.request.toLowerCase())) examples.unshift(about.request);

  let parameter: LearnedParameter | null = null;
  const p = c.parameter as { name?: unknown; describe?: unknown; leads?: unknown } | null | undefined;
  if (p && str(p.name)) {
    const leads = (Array.isArray(p.leads) ? (p.leads as unknown[]) : []).map(str).filter((l): l is string => Boolean(l));
    if (leads.length === 0) return { ok: false, reason: "The new command takes a value but not how to hear it" };
    parameter = { name: snake(str(p.name)!), describe: str(p.describe) ?? str(p.name)!, leads: leads.slice(0, 8) };
  }

  const rawSteps = Array.isArray(c.steps) ? (c.steps as RawStep[]) : [];
  if (rawSteps.length === 0) return { ok: false, reason: "The new command had no steps" };
  if (rawSteps.length > MAX_STEPS) return { ok: false, reason: "The new command had too many steps" };
  const steps: LearnedStep[] = [];
  let confirm = false;
  for (const raw of rawSteps) {
    const r = toStep(raw, checks);
    if (typeof r === "string") return { ok: false, reason: r.charAt(0).toUpperCase() + r.slice(1) };
    steps.push(r.step);
    confirm ||= r.destructive;
  }
  const usesValue = JSON.stringify(steps).includes(PARAM);
  if (usesValue && !parameter) return { ok: false, reason: "The new command uses a value it never asks for" };

  return {
    ok: true,
    command: {
      id, title, describe, examples, parameter, steps, confirm,
      learnedFrom: about.request,
      learnedAt: (about.now ?? new Date()).toISOString(),
      model: about.model,
      uses: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

/** The value a request carries for a learned command's parameter, verbatim. */
export function parameterValue(command: LearnedCommand, transcript: string): string | null {
  if (!command.parameter) return null;
  return afterPhrase(transcript, [...command.parameter.leads]);
}

/** A step with the value filled in: encoded in an address, as said in text. */
export function withValue(step: LearnedStep, value: string | null): LearnedStep {
  if (value === null) return step;
  switch (step.do) {
    case "open_url":
      return { ...step, url: step.url.replaceAll(PARAM, encodeURIComponent(value)) };
    case "type":
      return { ...step, text: step.text.replaceAll(PARAM, value) };
    case "click":
      return { ...step, target: step.target.replaceAll(PARAM, value) };
    case "action":
      return {
        ...step,
        args: Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, v.replaceAll(PARAM, value)])),
      };
    default:
      return step;
  }
}

/** What a command does, short enough for the overlay: "Open Slack, then press ⌘N". */
export function summarize(command: LearnedCommand): string {
  const said = (s: LearnedStep): string => {
    switch (s.do) {
      case "action": {
        const shown = Object.values(s.args).filter(Boolean).join(" ");
        return `${s.action.replace(/_/g, " ")}${shown ? ` ${shown}` : ""}`;
      }
      case "keys":
        return `press ${s.combo}${s.app ? ` in ${s.app}` : ""}`;
      case "menu":
        return `choose ${s.path.join(" › ")}${s.app ? ` in ${s.app}` : ""}`;
      case "open_url":
        return `open ${s.url.replace(/^https?:\/\//, "").split(/[/?]/)[0]}`;
      case "type":
        return `type "${s.text.length > 24 ? `${s.text.slice(0, 23)}…` : s.text}"`;
      case "click":
        return `click ${s.target}`;
      case "wait":
        return "wait";
    }
  };
  const parts = command.steps.filter((s) => s.do !== "wait").map(said);
  const text = parts.join(", then ");
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return sentence.length > 110 ? `${sentence.slice(0, 109)}…` : sentence;
}
