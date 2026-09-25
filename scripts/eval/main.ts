/**
 * Understanding check: does each request pick the right command AND the right
 * thing to act on — the app, the settings page — on this Mac?
 *
 * Replays requests through the real router, against the live Jev API, with the
 * apps actually installed here. Nothing is executed. The cases are the ways
 * real use went wrong: describing an app instead of naming it ("open selfie
 * camera"), browsers ("open my browser", then a search), and look-alike
 * commands (a photo is not a screenshot).
 *
 *   npm run eval
 *   npm run eval -- camera      # only the cases containing "camera"
 *
 * Runs inside Electron so it uses the same network stack and the same stored
 * API key as the app itself. The key is never printed.
 */
import { app } from "electron";
import { SLOT_CONFIDENCE_MIN, instantRoute } from "../../src/main/actions/realtime.ts";
import { splitCommands } from "../../src/main/actions/split.ts";
import type { ActionContext } from "../../src/main/actions/types.ts";
import * as jev from "../../src/main/jev/client.ts";
import { type RouteDecision, route } from "../../src/main/jev/router.ts";
import { platform } from "../../src/main/platform/index.ts";
import { getSettings } from "../../src/main/settings-store.ts";

const ROOT = process.env.JEV_ROOT ?? process.cwd();
// Same name as the app, so the same settings file and Keychain entry.
app.setName("jev-voice-agent");
(app as unknown as { getAppPath: () => string }).getAppPath = () => ROOT;

type Env = Omit<ActionContext, "transcript">;

interface Case {
  say: string;
  /** Acceptable commands — for a chain, one list per clause, joined by " + ". */
  expect: string[];
  /** The app or settings page it should act on, where there is one. */
  target?: string | RegExp;
  /** Asking "which one?" is a fine answer too: the request is ambiguous. */
  mayAsk?: boolean;
  /** How the Mac looks when it is said. */
  env?: Partial<Env>;
}

const BROWSERS_OPEN = { runningApps: ["Finder", "Safari", "Google Chrome"] };
const ON_RESULTS = {
  focusedApp: "Google Chrome",
  windowTitle: "youtube - Google Search",
  runningApps: ["Finder", "Google Chrome"],
  lastBrowser: "Google Chrome",
  lastPage: "https://www.google.com/search?q=youtube",
  recent: ["Opened Google Chrome", 'Searched for "youtube"'],
};
const IN_CHROME = { focusedApp: "Google Chrome", ...BROWSERS_OPEN, lastBrowser: "Google Chrome" };

const CASES: Case[] = [
  // --- describing an app instead of naming it ------------------------------
  { say: "open selfie camera.", expect: ["open_app"], target: "Photo Booth" },
  { say: "open my camera", expect: ["open_app"], target: "Photo Booth" },
  { say: "open camera to take a selfie.", expect: ["open_app", "take_photo"], target: /Photo Booth|^$/ },
  { say: "open the camera app", expect: ["open_app"], target: "Photo Booth" },
  { say: "open my browser.", expect: ["open_app"], target: /Safari|Google Chrome/ },
  { say: "open the browser", expect: ["open_app"], target: "Google Chrome", env: { runningApps: ["Finder", "Google Chrome"] } },
  { say: "open my code editor", expect: ["open_app"], target: /Cursor|PhpStorm|WebStorm|PyCharm|Xcode/, mayAsk: true },
  { say: "open the terminal", expect: ["open_app"], target: "Terminal" },
  { say: "open the password manager", expect: ["open_app"], target: /Bitwarden|Passwords/, mayAsk: true },
  { say: "open my email", expect: ["open_app", "open_url"], target: /Mail|Microsoft Outlook|mail\.google\.com/ },
  { say: "open the file manager", expect: ["open_app"], target: "Finder" },
  { say: "open the task manager", expect: ["open_app"], target: "Activity Monitor" },
  { say: "open settings", expect: ["open_app", "open_settings"], target: "System Settings" },
  { say: "open chat gpt", expect: ["open_app"], target: /ChatGPT/ },
  // --- camera versus screen ------------------------------------------------
  { say: "take a selfie", expect: ["take_photo"] },
  { say: "take a photo", expect: ["take_photo"] },
  { say: "take a picture of me", expect: ["take_photo"] },
  { say: "take a screenshot", expect: ["screenshot_screen"] },
  // --- the web, and which browser ------------------------------------------
  { say: "search for youtube.com", expect: ["web_search", "open_url"], env: IN_CHROME },
  { say: "search for youtube", expect: ["web_search", "open_url"], env: IN_CHROME },
  { say: "open the YouTube", expect: ["open_url"], env: IN_CHROME },
  { say: "search youtube for cats", expect: ["web_search"], env: IN_CHROME },
  { say: "play lofi music on youtube", expect: ["web_search"], env: IN_CHROME },
  { say: "search for cats there", expect: ["web_search"], env: { ...IN_CHROME, windowTitle: "lofi hip hop radio - YouTube" } },
  { say: "open youtube in chrome", expect: ["open_url"], env: { focusedApp: "Safari" } },
  { say: "search for pasta recipes in safari", expect: ["web_search"] },
  { say: "google the weather", expect: ["web_search"] },
  { say: "go to github dot com", expect: ["open_url"] },
  // --- on a page of results, in the browser in use -------------------------
  { say: "open browser.", expect: ["open_app"], target: /Safari|Google Chrome/ },
  { say: "search for YouTube", expect: ["web_search"], env: { focusedApp: "Google Chrome", runningApps: ["Finder", "Google Chrome"] } },
  { say: "open YouTube.", expect: ["open_url", "click_on"], env: ON_RESULTS },
  { say: "click youtube", expect: ["click_on"], target: "youtube", env: ON_RESULTS },
  { say: "click on youtube", expect: ["click_on"], target: "youtube", env: ON_RESULTS },
  { say: "click the first result", expect: ["click_on"], target: "first result", env: ON_RESULTS },
  { say: "open the second result", expect: ["click_on"], target: "second result", env: ON_RESULTS },
  { say: "click on images", expect: ["click_on"], target: "images", env: ON_RESULTS },
  { say: "click sign in", expect: ["click_on"], target: "sign in", env: ON_RESULTS },
  { say: "press the continue button", expect: ["click_on"], target: "continue" },
  { say: "press enter", expect: ["press_enter"] },
  { say: "go back", expect: ["go_back"], env: ON_RESULTS },
  { say: "open chrome and search for youtube", expect: ["open_app + web_search"] },
  { say: "search for cats and click the first result", expect: ["web_search + click_on"], env: ON_RESULTS },
  // --- closing and quitting ------------------------------------------------
  { say: "close the browser.", expect: ["close_app_window"], target: "Google Chrome", env: IN_CHROME },
  { say: "close all browsers.", expect: ["quit_app", "close_app_window"], target: "Every open web browser", env: BROWSERS_OPEN },
  { say: "quit chrome", expect: ["quit_app"], target: "Google Chrome", env: BROWSERS_OPEN },
  { say: "close this window", expect: ["close_window"] },
  { say: "close it", expect: ["close_window", "close_app_window"], env: { ...IN_CHROME, recent: ["Opened Google Chrome"] } },
  // --- settings pages ------------------------------------------------------
  { say: "open bluetooth settings", expect: ["open_settings"], target: "Bluetooth" },
  { say: "open wifi settings", expect: ["open_settings"], target: "Wi-Fi" },
  { say: "turn on bluetooth", expect: ["open_settings"], target: "Bluetooth" },
  { say: "change my wallpaper", expect: ["open_settings"], target: "Wallpaper" },
  { say: "show me the display settings", expect: ["open_settings"], target: "Displays" },
  { say: "check for software updates", expect: ["open_settings"], target: "Software Update" },
  // --- the rest still works ------------------------------------------------
  { say: "set the volume to thirty percent", expect: ["set_volume"] },
  { say: "open Notes and create a new note", expect: ["open_app + new_window"] },
  { say: "turn on dark mode", expect: ["dark_mode_on"] },
];

const pct = (n: number | undefined) => (n === undefined ? "  -  " : n.toFixed(2).padStart(5));

async function main(): Promise<void> {
  await app.whenReady();
  const settings = getSettings();
  const only = process.argv.slice(2).find((a) => !a.startsWith("-"))?.toLowerCase();

  const os = platform();
  const [installed, running, automations, defaultBrowser, windowed] = await Promise.all([
    os.listApps(), os.runningApps(), os.listAutomations(), os.defaultBrowser(), os.windowedApps().catch(() => undefined),
  ]);
  const base: Env = {
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: running,
    ...(windowed ? { windowedApps: windowed } : {}),
    installedApps: [...installed].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).map((a) => a.name),
    automations,
    defaultBrowser,
  };
  process.stdout.write(`${installed.length} apps installed, ${running.length} running, default browser ${defaultBrowser}\n\n`);
  jev.warm();

  let right = 0;
  const times: number[] = [];
  const tokens: number[] = [];
  const cases = CASES.filter((c) => !only || c.say.toLowerCase().includes(only));
  for (const c of cases) {
    const decideOne = async (clause: string): Promise<RouteDecision> => {
      const ctx: ActionContext = { ...base, ...c.env, transcript: clause };
      return (settings.instantCommands ? instantRoute(clause, ctx) : null) ??
        (await route(ctx, { confidenceThreshold: settings.confidenceThreshold, offlineFallback: false }));
    };
    // As the app does: a chain is split, and each clause decided on its own.
    const clauses = splitCommands(c.say);
    const decisions = await Promise.all(clauses.map(decideOne));
    const d: RouteDecision = decisions.length === 1
      ? decisions[0]!
      : {
          ...decisions.at(-1)!,
          action: decisions.map((x) => x.action).join(" + ") as RouteDecision["action"],
          confidence: Math.min(...decisions.map((x) => x.confidence)),
        };
    const target = String(d.args.app ?? d.args.pane ?? d.args.url ?? d.args.target ?? d.args.query ?? "");
    const actionOk = d.action !== null && c.expect.includes(d.action);
    const targetOk =
      c.target === undefined || (typeof c.target === "string" ? target === c.target : c.target.test(target));
    const asks = d.slotConfidence !== undefined && d.slotConfidence < SLOT_CONFIDENCE_MIN;
    const acts = d.confidence >= settings.confidenceThreshold && !d.reason && !asks;
    const ok = actionOk && targetOk && (acts || (asks && c.mayAsk === true));
    if (ok) right++;
    if (!d.instant) {
      times.push(d.ms);
      tokens.push(d.inputTokens);
    }
    process.stdout.write(
      `${ok ? "  ok " : "  MISS"}  ${c.say.padEnd(38)} ${String(d.action).padEnd(17)} ${target.slice(0, 26).padEnd(26)} ` +
        `cmd ${pct(d.confidence)}  slot ${pct(d.slotConfidence)}  ${d.instant ? "instant" : `${d.ms} ms`}` +
        (d.alternative ? `  (next: ${d.alternative})` : "") +
        (asks ? "  → asks which one" : "") +
        (d.reason ? `  — ${d.reason}` : "") +
        "\n",
    );
  }

  const sorted = [...times].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const meanTokens = tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0;
  process.stdout.write(
    `\n${right}/${cases.length} right   routing p50 ${q(0.5)} ms   p90 ${q(0.9)} ms   ${meanTokens} input tokens per request\n`,
  );
  app.exit(0);
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.message : err);
  app.exit(1);
});
