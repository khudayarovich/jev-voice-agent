import type { KeyCombo, PlatformAdapter } from "../platform/types.ts";
import { type LearnedCommand, type LearnedStep, isScriptRunner, withValue } from "./lesson.ts";

/**
 * Running a learned command: its steps, in order, each through machinery the
 * agent already has — its own commands, a keystroke, a menu, the browser, the
 * clicking helper. There is no step that runs anything else.
 */

export interface StepDeps {
  os: PlatformAdapter;
  /** One of the agent's own commands, arguments as words: ("open_app", {app: "Slack"}). */
  runAction(action: string, args: Record<string, string>): Promise<void>;
  /** A page, shown the way the agent shows every page: in the browser and tab in use. */
  openUrl(url: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODIFIERS: Record<string, NonNullable<KeyCombo["modifiers"]>[number]> = {
  cmd: "command", shift: "shift", option: "option", ctrl: "control", fn: "fn",
};

/** "shift+cmd+n" → { key: "n", modifiers: ["shift", "command"] }. */
export function toKeyCombo(combo: string): KeyCombo {
  const parts = combo.split("+");
  // "cmd+-" and "cmd+=": the key itself may be the last character after a "+".
  const key = combo.endsWith("+") ? "+" : parts.pop()!;
  const modifiers = parts.map((p) => MODIFIERS[p]).filter((m): m is NonNullable<typeof m> => Boolean(m));
  return { key, ...(modifiers.length ? { modifiers } : {}) };
}

/** Bring an app to the front before sending it keys or choosing its menus. */
async function bringForward(app: string, os: PlatformAdapter): Promise<void> {
  await os.openApp(app);
  if (!(await os.waitForFrontmost((a) => a === app, 3000))) throw new Error(`${app} did not come to the front`);
}

/** Steps that put text or keys into whatever is in front. */
const typesOrPresses = (s: LearnedStep) =>
  s.do === "type" || s.do === "keys" || (s.do === "action" && ["type_text", "press_enter", "paste"].includes(s.action));

export async function runLearned(command: LearnedCommand, value: string | null, deps: StepDeps): Promise<void> {
  const { os } = deps;
  for (const [i, original] of command.steps.entries()) {
    const step = withValue(original, value);
    // The app the keys are for comes forward first; then, whatever the lesson
    // said, nothing is typed into a shell, where typed text is a command run.
    if (step.do === "keys" && step.app) await bringForward(step.app, os);
    if (typesOrPresses(step)) {
      const front = await os.frontApp().catch(() => "");
      if (front && isScriptRunner(front)) {
        throw new Error(`A learned command won't type into ${front}`);
      }
    }
    switch (step.do) {
      case "action":
        await deps.runAction(step.action, step.args);
        break;
      case "keys":
        await os.keystroke(toKeyCombo(step.combo));
        break;
      case "menu":
        if (step.app) await bringForward(step.app, os);
        await os.chooseMenuItem(step.path);
        break;
      case "open_url":
        await deps.openUrl(step.url);
        break;
      case "type":
        await os.typeText(step.text);
        break;
      case "click":
        await os.click({ text: step.target });
        break;
      case "element":
        await os.actOnElement(step.index, step.how, step.label);
        break;
      case "wait":
        await sleep(step.ms);
        break;
    }
    // A beat between steps, for a window, a menu or a page to catch up.
    if (i < command.steps.length - 1 && step.do !== "wait") await sleep(250);
  }
}
