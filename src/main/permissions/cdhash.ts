/** "CDHash=…" from `codesign -dvvv`, which prints its report on stderr. */
export function parseCdhash(report: string): string | null {
  return report.match(/^CDHash=([0-9a-f]+)\s*$/m)?.[1] ?? null;
}
