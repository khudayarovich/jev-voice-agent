import { ACTIONS, ACTION_KEYS, type ActionKey, isDestructive } from "../actions/registry.ts";
import type { ActionContext, EnumSlot, Slot } from "../actions/types.ts";
import { type LessonChecks, PARAM } from "./lesson.ts";

/**
 * The agent's own commands, as a lesson may use them: described for the
 * teacher, and checked when a lesson comes back. Built from the registry, so
 * the teacher always sees exactly the commands that exist.
 */

/** Commands that steer the agent itself, not the Mac: never a step. */
const NOT_STEPS = new Set<string>(["run_learned", "cancel", "stop_listening"]);

const stepKeys = () => ACTION_KEYS.filter((k) => !NOT_STEPS.has(k));

function slotsOf(key: ActionKey): [string, Slot][] {
  return Object.entries(ACTIONS[key].slots as Record<string, Slot>);
}

/** Every value an enum slot accepts here, or null for "any app". */
async function allowed(slot: EnumSlot, ctx: ActionContext): Promise<string[] | null> {
  if (slot.group === "app") return null;
  return [...(await slot.candidates(ctx))];
}

/** "- open_app(app: an app from the list): Launch an application…", one per command. */
export async function commandCatalog(ctx: ActionContext): Promise<string> {
  const lines: string[] = [];
  for (const key of stepKeys()) {
    const args: string[] = [];
    for (const [name, slot] of slotsOf(key)) {
      if (slot.kind === "number") args.push(`${name}: a number`);
      else if (slot.kind === "text") args.push(`${name}: text`);
      else {
        const values = await allowed(slot, ctx);
        args.push(values === null ? `${name}: an app from the list` : `${name}: one of ${values.map((v) => `"${v}"`).join(", ") || "(none here)"}`);
      }
    }
    lines.push(`- ${key}(${args.join("; ")}): ${ACTIONS[key].describe}`);
  }
  return lines.join("\n");
}

/** The checks a lesson's steps must pass, against this Mac as it is now. */
export async function lessonChecks(
  ctx: ActionContext,
  learnedIds: string[],
  screen?: { role: string; label: string }[],
): Promise<LessonChecks> {
  const apps = [...new Set([...ctx.runningApps, ...ctx.installedApps])];
  const values = new Map<string, string[] | null>();
  for (const key of stepKeys()) {
    for (const [name, slot] of slotsOf(key)) {
      if (slot.kind === "enum") values.set(`${key}.${name}`, await allowed(slot, ctx));
    }
  }
  const lower = new Map(apps.map((a) => [a.toLowerCase(), a]));

  return {
    apps,
    ...(screen ? { screen } : {}),
    takenIds: new Set([...ACTION_KEYS, ...learnedIds]),
    isDestructive: (action) => ACTION_KEYS.includes(action as ActionKey) && isDestructive(action as ActionKey),
    checkAction(action, args) {
      if (!ACTION_KEYS.includes(action as ActionKey) || NOT_STEPS.has(action)) return `"${action}" is not a command`;
      for (const [name, slot] of slotsOf(action as ActionKey)) {
        const value = args[name];
        if (value === undefined || value.trim() === "") return `${action} needs its ${name}`;
        if (slot.kind === "number") {
          if (!Number.isFinite(Number(value))) return `${action}'s ${name} must be a number`;
        } else if (slot.kind === "enum") {
          if (value.includes(PARAM)) return `${action}'s ${name} cannot come from what was said`;
          const accepted = values.get(`${action}.${name}`);
          if (accepted === null ? !lower.has(value.toLowerCase()) : !accepted?.includes(value)) {
            return `"${value}" is not ${/^[aeiou]/i.test(name) ? "an" : "a"} ${name} ${action} knows`;
          }
        }
      }
      return null;
    },
  };
}

/** A learned step's arguments, as the command's own slots take them. */
export function typedArgs(
  action: ActionKey,
  args: Record<string, string>,
  apps: string[],
): Record<string, string | number> {
  const lower = new Map(apps.map((a) => [a.toLowerCase(), a]));
  const out: Record<string, string | number> = {};
  for (const [name, slot] of slotsOf(action)) {
    const value = args[name] ?? "";
    if (slot.kind === "number") out[name] = Number(value);
    else if (slot.kind === "enum" && slot.group === "app") out[name] = lower.get(value.toLowerCase()) ?? value;
    else out[name] = value;
  }
  return out;
}
