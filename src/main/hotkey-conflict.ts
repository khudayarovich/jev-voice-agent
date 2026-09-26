/**
 * Hotkeys macOS already uses.
 *
 * Ctrl+Space is "Select the previous input source" whenever more than one
 * keyboard layout is enabled — and registering it as the agent's own hotkey
 * took it away from the user, who switches layouts all day, and had every
 * switch poke the agent. Observed in real use.
 */

/** The symbolic hotkeys that switch input sources: previous, next. */
const INPUT_SOURCE_KEYS = ["60", "61"];

/** The key code and modifier mask an accelerator like "Control+Space" means, as the defaults file spells them. */
function meaning(accelerator: string): { keyCode: number; modifiers: number } | null {
  const parts = accelerator.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  const codes: Record<string, number> = { space: 49, tab: 48, escape: 53, return: 36 };
  if (!key || !(key in codes)) return null;
  const masks: Record<string, number> = { control: 262144, ctrl: 262144, option: 524288, alt: 524288, shift: 131072, command: 1048576, cmd: 1048576 };
  let modifiers = 0;
  for (const p of parts) {
    if (!(p in masks)) return null;
    modifiers |= masks[p]!;
  }
  return { keyCode: codes[key]!, modifiers };
}

/**
 * Whether `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`
 * shows this accelerator switching input sources. Parsed by hand: the output
 * is the old NeXT plist text, and only two entries matter.
 */
export function switchesInputSource(defaultsOutput: string, accelerator: string): boolean {
  const wanted = meaning(accelerator);
  if (!wanted) return false;
  for (const id of INPUT_SOURCE_KEYS) {
    const entry = defaultsOutput.match(new RegExp(`\\n\\s+${id} =\\s+\\{([^]*?)\\n\\s+\\};`));
    if (!entry) continue;
    const body = entry[1]!;
    if (!/enabled = 1;/.test(body)) continue;
    const params = body.match(/parameters =\s*\(\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\)/);
    if (!params) continue;
    const [, , keyCode, modifiers] = params;
    if (Number(keyCode) === wanted.keyCode && (Number(modifiers) & 0x1f0000) === wanted.modifiers) return true;
  }
  return false;
}
