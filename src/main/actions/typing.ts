import type { PlatformAdapter } from "../platform/types.ts";

/**
 * Typing that knows whether it landed.
 *
 * Pasting into "whatever is focused" went nowhere whenever nothing was —
 * a window just brought forward, a chat whose composer had lost the focus —
 * and was reported as typed. Observed in real use, in OpenCode, twice. So
 * the front window's text input is focused first, the text is read back
 * after, and a miss gets one more try; when the input cannot be read at all,
 * that is said rather than "done".
 */
export type Landed = "yes" | "no" | "unknown";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function typeChecked(os: PlatformAdapter, text: string): Promise<Landed> {
  const snippet = text.slice(0, 40).toLowerCase();
  for (let attempt = 0; attempt < 2; attempt++) {
    await os.focusInput().catch(() => false);
    await os.typeText(text);
    await sleep(300);
    const value = await os.inputValue().catch(() => null);
    if (typeof value !== "string") return "unknown";
    if (value.toLowerCase().includes(snippet)) return "yes";
  }
  return "no";
}

/** Type, and throw when the text plainly did not arrive. */
export async function typeOrFail(os: PlatformAdapter, text: string, where: string): Promise<Landed> {
  const landed = await typeChecked(os, text);
  if (landed === "no") throw new Error(`Couldn't get the text into ${where}'s input`);
  return landed;
}
