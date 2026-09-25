/**
 * Parsing what macOS says about installed apps: Spotlight's metadata for each
 * bundle, and LaunchServices' record of which app opens links.
 *
 * Pure functions, so the parsing is tested without a Mac's state behind it.
 */

/**
 * `mdls` output for several files, one record per file.
 *
 *   kMDItemCFBundleIdentifier = "com.apple.Safari"
 *   kMDItemFSName             = "Safari.app"
 *   kMDItemLastUsedDate       = 2026-09-25 11:20:07 +0000
 *
 * mdls prints each file's attributes alphabetically, whatever order they were
 * asked for in, and a missing one as `(null)`. A record ends where an
 * attribute repeats.
 */
export function parseMdls(stdout: string): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(kMDItem\w+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, name, raw] = m as unknown as [string, string, string];
    if (name in current) {
      records.push(current);
      current = {};
    }
    const value = raw.trim();
    if (value === "(null)") continue;
    current[name] = value.replace(/^"(.*)"$/, "$1");
  }
  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

/** `2026-09-25 11:20:07 +0000` as epoch ms, or undefined. */
export function parseMdlsDate(value: string | undefined): number | undefined {
  const m = value?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(ms) ? ms : undefined;
}

interface Handler {
  LSHandlerURLScheme?: string;
  LSHandlerRoleAll?: string;
}

/**
 * The bundle id of the app that opens web links, from the LaunchServices
 * preferences (converted to JSON). Null means the user never chose one, and
 * Safari — the system default — opens them.
 */
export function defaultBrowserId(prefs: unknown): string | null {
  const handlers = (prefs as { LSHandlers?: Handler[] } | null)?.LSHandlers;
  if (!Array.isArray(handlers)) return null;
  for (const scheme of ["https", "http"]) {
    const id = handlers.find((h) => h.LSHandlerURLScheme?.toLowerCase() === scheme)?.LSHandlerRoleAll;
    if (id && id !== "-") return id;
  }
  return null;
}
