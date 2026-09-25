/**
 * Builds whisper's initial prompt.
 *
 * This turned out to matter more than the model. Measured over a set of spoken
 * commands, the same model went from 6.9% word error rate to 2.8% purely by
 * being told what vocabulary to expect — a bigger improvement than upgrading
 * from `base.en` to `large-v3-turbo`, which changed nothing.
 *
 * The reason is that almost every failure is a proper noun. A recogniser has no
 * idea "Slack" or "iTerm" is a word unless something suggests it, and those are
 * exactly the words a command hinges on. Seeding the prompt with the apps that
 * are actually installed on THIS Mac fixes the problem at its source.
 */

/** whisper's prompt is bounded; keep well inside it. */
const MAX_PROMPT_CHARS = 900;

/**
 * A few representative phrasings, so the model expects the shape of an
 * instruction rather than of prose — chosen for the words the recogniser gets
 * wrong without a hint. With app names alone in the prompt, "take a photo"
 * came out as "take a Phone" (Phone being an app) and opened the Phone app.
 * Kept short: every character here is one fewer app name that fits.
 */
const PHRASINGS = [
  "Open Safari",
  "Take a photo",
  "Take a screenshot",
  "Search YouTube for cats",
  "Open Bluetooth settings",
  "Set the volume to 30 percent",
  "Close the browser",
];

export interface VocabularyApp {
  name: string;
  /** Epoch ms of last launch, when known. */
  lastUsed?: number;
}

export function buildVocabularyPrompt(
  installedApps: (string | VocabularyApp)[],
  runningApps: string[] = [],
): string {
  const running = new Set(runningApps);
  const entries = installedApps.map((a) => (typeof a === "string" ? { name: a } : a));
  for (const name of runningApps) {
    if (!entries.some((e) => e.name === name)) entries.push({ name });
  }

  /**
   * Order by how likely the user is to say it.
   *
   * The list must be cut somewhere — whisper's prompt is a couple of hundred
   * tokens and a Mac has a hundred apps — and cutting it alphabetically is the
   * worst possible choice: it drops Safari, Slack, Terminal and Xcode while
   * keeping every utility starting with "A". Running first, then most recently
   * launched, then the rest.
   */
  const apps = entries
    .filter((a) => a.name && !/^com\./.test(a.name))
    .sort((a, b) => {
      const ra = running.has(a.name) ? 0 : 1;
      const rb = running.has(b.name) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ua = a.lastUsed ?? 0;
      const ub = b.lastUsed ?? 0;
      if (ua !== ub) return ub - ua;
      return a.name.localeCompare(b.name);
    })
    .map((a) => a.name);

  /**
   * Structure matters as much as content.
   *
   * An earlier version ended with the comma-separated app list, and whisper
   * continued that style — returning "OpenBitwarden" and "OpenMoonlight" with
   * the spaces run out of them. The words were right; the shape was wrong.
   * Ending on ordinary, well-spaced imperative sentences gives the decoder the
   * shape to continue instead.
   */
  const head = "Voice commands for a Mac. Installed applications include: ";
  const tail = ` Examples: ${PHRASINGS.join(". ")}.`;

  const parts: string[] = [];
  for (const app of apps) {
    const next = `${head}${[...parts, app].join(", ")}.${tail}`;
    if (next.length > MAX_PROMPT_CHARS) break;
    parts.push(app);
  }
  return `${head}${parts.join(", ")}.${tail}`;
}
