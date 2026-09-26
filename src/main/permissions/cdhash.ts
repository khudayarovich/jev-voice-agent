/** "CDHash=…" from `codesign -dvvv`, which prints its report on stderr. */
export function parseCdhash(report: string): string | null {
  return report.match(/^CDHash=([0-9a-f]+)\s*$/m)?.[1] ?? null;
}

/**
 * What macOS keys the app's grants by. Signed with a certificate, that is the
 * certificate — the same for every build, so grants survive an update. Signed
 * ad hoc, it is the code hash, new with every build.
 */
export function signingIdentity(report: string): string | null {
  const adhoc = /^Signature=adhoc\s*$/m.test(report);
  const authority = report.match(/^Authority=(.+?)\s*$/m)?.[1];
  if (!adhoc && authority) return `cert:${authority}`;
  const hash = parseCdhash(report);
  return hash ? `cdhash:${hash}` : null;
}
