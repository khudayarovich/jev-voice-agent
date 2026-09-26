import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, systemPreferences } from "electron";
import { log } from "../log.ts";
import { signingIdentity } from "./cdhash.ts";
import { screenHelper } from "../platform/macos/index.ts";

const exec = promisify(execFile);

/**
 * Grants that go stale with an update.
 *
 * macOS keys each grant to the app's code signature, and every build of an
 * ad-hoc signed app has a new one. After an update System Settings still shows
 * Accessibility ticked while every call fails — observed in real use: "close
 * notepad" failed three times with "Accessibility permission is needed" with
 * the tick plainly on. So an update clears its own stale grants and asks
 * afresh: the prompts come back, and the tick means what it says.
 */

const APP_ID = "ai.jev.voiceagent";

/** TCC service names, as `tccutil reset` takes them. */
const SERVICES = ["Accessibility", "ScreenCapture", "Microphone", "AppleEvents"];

/** The signature macOS keys the grants by; null outside a packaged Mac app. */
async function codeHash(): Promise<string | null> {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  try {
    const { stderr } = await exec("/usr/bin/codesign", ["-dvvv", bundle], { timeout: 5000 });
    return signingIdentity(stderr);
  } catch {
    return null;
  }
}

/**
 * Clear the grants left by a previous build and ask for them again. True when
 * that happened, so the caller can send the user to the Permissions pane.
 */
export async function resetGrantsIfUpdated(): Promise<boolean> {
  const hash = await codeHash();
  if (!hash) return false;

  const marker = path.join(app.getPath("userData"), "install.json");
  const last = await readFile(marker, "utf8")
    .then((s) => (JSON.parse(s) as { cdhash?: string }).cdhash)
    .catch(() => undefined);
  if (last === hash) return false;
  await writeFile(marker, JSON.stringify({ cdhash: hash, at: new Date().toISOString() })).catch(() => {});

  // No marker means a first install, where there is nothing to clear, or a
  // build from before markers existed, whose grants are stale — and a stale
  // grant reads as not granted, so it cannot be told from none. Clearing
  // nothing costs nothing: clear either way.
  for (const service of SERVICES) {
    await exec("/usr/bin/tccutil", ["reset", service, APP_ID], { timeout: 5000 }).catch((err: Error) =>
      log("permissions", "reset-failed", { service, message: err.message }),
    );
  }
  log("permissions", "reset-after-update", { from: last?.slice(0, 8) ?? "none", to: hash.slice(0, 8) });

  // Ask again straight away, in the order the user meets them. Each of these
  // puts the app back in its list in System Settings, unticked, so the user
  // ticks it there once and it holds until the next update.
  await systemPreferences.askForMediaAccess("microphone").catch(() => false);
  systemPreferences.isTrustedAccessibilityClient(true);
  await exec(screenHelper(), ["request", "--screen"], { timeout: 5000 }).catch(() => {});
  return true;
}
