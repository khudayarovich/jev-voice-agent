/**
 * Parsing `lsappinfo`, LaunchServices' own view of running applications.
 *
 * It answers the two questions every command needs — what is running, and what
 * is in front — in 10-50 ms, against 180-400 ms for the same answers from
 * System Events over AppleScript. It also needs no Automation grant, so the
 * context no longer degrades to nothing on a machine where that grant is
 * missing.
 */

/**
 * Regular apps from `lsappinfo list`: those of type "Foreground", which is what
 * System Events calls `background only is false` — the apps with a Dock icon.
 *
 *   100) "Google Chrome" ASN:0x0-0x63d63d:
 *       bundleID="com.google.Chrome"
 *       ...
 *       pid = 44964 type="Foreground" flavor=3 ...
 */
export function parseForegroundApps(listing: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of listing.split("\n")) {
    const header = line.match(/^\s*\d+\)\s+"(.*)"\s+ASN:/);
    if (header) {
      current = header[1] ?? null;
      continue;
    }
    if (current && /\btype="Foreground"/.test(line)) {
      out.push(current);
      current = null;
    }
  }
  return [...new Set(out)];
}

/** `"LSDisplayName"="Safari"` from `lsappinfo info -only name <ASN>`. */
export function parseDisplayName(info: string): string {
  return info.match(/"LSDisplayName"\s*=\s*"(.*)"/)?.[1] ?? "";
}
