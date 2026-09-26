/**
 * What the teacher is told. Pure text, built from facts the agent gathered
 * itself: its own commands, the apps installed, the app in front. Nothing
 * from a web page or the clipboard goes in — not even a window title, which a
 * web page chooses.
 */

export interface LessonFacts {
  /** What the user said. */
  request: string;
  /** From commandCatalog(): the agent's own commands, one per line. */
  catalog: string;
  apps: string[];
  shortcuts: string[];
  focusedApp: string;
  /** What is on screen now, one line per item: "14: Button "Details…" @812,301 60×22". */
  screen?: string[];
}

export const TEACHER_RULES = `You teach a Mac voice assistant a command it does not have yet.

The user asked for something the assistant has no command for. Design ONE new command that does it, built only from the steps below. You cannot write code, scripts, shell commands or AppleScript. If the task needs those, or cannot be done with these steps, answer possible=false with a short reason addressed to the user, and command=null.

Steps (every field of a step is present; those it does not use are null):
- action: run one of the assistant's own commands, listed below, with each of its arguments as a {name, value} pair of strings. Prefer this whenever one fits.
- keys: press a standard, well-known keyboard shortcut, like "cmd+shift+n". Set app to bring that app to the front first.
- menu: choose a menu item, as a path of two or three names exactly as they appear in the menu bar, like ["File", "New Folder"]. Set app to bring that app to the front first.
- open_url: open an https address in the user's browser.
- type: type text into whatever is focused.
- click: click a button, link or list item on screen by the words on it.
- element: one item from the list of what is on screen right now, by its index, with how: press, select (a row), focus (a text input, before typing), scroll_down or scroll_up (a scroll area or list). Use this when the request is about what is on the screen now — "the details of the connected network", "the video that is 3 minutes long", "scroll the right pane" — choosing by the items' words and places (x grows to the right, y downwards). A command with element steps is done once and not remembered, so its examples matter less; still describe it.
- wait: pause for ms milliseconds, at most 3000 — after opening an app or a page, before acting on it.

A value: if the request carries something that will differ each time ("search Amazon for headphones"), define one parameter — a name, a description, and the phrases the value follows in a request ("search amazon for", "find on amazon", "look up on amazon") — and write {value} where it goes in a step: an address, text to type, a click target, or a text argument. Otherwise parameter is null.

The command:
- id: short snake_case.
- title: a few words, like a menu item: "New Finder window", "Search Amazon".
- describe: one or two sentences stating precisely what it does, for a router that chooses commands by their descriptions. Say how it differs from any similar command listed.
- examples: three to six ways a person would ask for it, lowercase, including the request itself.
- steps: as few as do the job, in order.

Never design a command that deletes, erases, empties, sends, submits, buys, pays, logs out, restarts or shuts down anything, quits apps by shortcut (there is a quit command), or touches passwords, payments or security settings. For those, possible=false.`;

export function lessonMessages(facts: LessonFacts): { role: "system" | "user"; content: string }[] {
  const context = [
    "The assistant's own commands, as name(arguments): what it does:",
    facts.catalog,
    "",
    `Apps on this Mac: ${facts.apps.join(", ")}`,
    `The user's Shortcuts: ${facts.shortcuts.length ? facts.shortcuts.join(", ") : "none"}`,
    `The app in front: ${facts.focusedApp || "unknown"}`,
    ...(facts.screen?.length
      ? ["", `On screen now, in ${facts.focusedApp || "the front window"} (index: kind "words" [= value] @x,y w×h):`, ...facts.screen]
      : []),
  ].join("\n");
  return [
    { role: "system", content: `${TEACHER_RULES}\n\n${context}` },
    { role: "user", content: `The user said: "${facts.request}"` },
  ];
}
