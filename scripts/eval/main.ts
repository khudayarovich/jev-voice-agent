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
import { commandCatalog, lessonChecks } from "../../src/main/learning/catalog.ts";
import { checkLesson, summarize } from "../../src/main/learning/lesson.ts";
import { lessonMessages } from "../../src/main/learning/prompt.ts";
import { askTeacher } from "../../src/main/learning/teacher.ts";
import { splitCommands } from "../../src/main/actions/split.ts";
import type { ActionContext } from "../../src/main/actions/types.ts";
import * as jev from "../../src/main/jev/client.ts";
import { type RouteDecision, route } from "../../src/main/jev/router.ts";
import { platform } from "../../src/main/platform/index.ts";
import { getOpenRouterKey, getSettings } from "../../src/main/settings-store.ts";

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
const ON_YOUTUBE = {
  focusedApp: "Google Chrome",
  windowTitle: "YouTube",
  runningApps: ["Finder", "Google Chrome"],
  lastBrowser: "Google Chrome",
  lastPage: "youtube.com",
  recent: ["Opened Google Chrome", "Opened youtube.com"],
};
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
  { say: "open the browser", expect: ["open_app"], target: "Google Chrome", env: { runningApps: ["Finder", "Google Chrome"], windowedApps: ["Finder", "Google Chrome"] } },
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
  // --- from real use, the second session ----------------------------------
  { say: "Click on Wi-Fi.", expect: ["click_on"], target: /wi-?fi/i, env: { focusedApp: "System Settings", windowTitle: "Network" } },
  { say: "click wifi", expect: ["click_on"], target: /wi-?fi/i, env: { focusedApp: "System Settings", windowTitle: "Network" } },
  { say: "Play some video from YouTube.", expect: ["click_on"], target: "some video", env: ON_YOUTUBE },
  { say: "Play some video.", expect: ["click_on"], target: "some video", env: ON_YOUTUBE },
  { say: "play the first video", expect: ["click_on"], target: "first video", env: ON_YOUTUBE },
  { say: "pause the music", expect: ["media_play_pause"] },
  { say: "resume the music", expect: ["media_play_pause"] },
  { say: "play", expect: ["media_play_pause"] },
  // --- nothing fits: the cue to learn a new command ------------------------
  { say: "create a new folder on the desktop", expect: ["new_folder", "unknown_task"] },
  { say: "set a timer for five minutes", expect: ["unknown_task"] },
  { say: "show hidden files in finder", expect: ["unknown_task"] },
  { say: "open a private window in chrome", expect: ["unknown_task", "new_window"] },
  { say: "search amazon for headphones", expect: ["web_search"] },
  // --- from real use, the third session -----------------------------------
  { say: "Open Yandex Music", expect: ["open_url", "unknown_task"], target: /music\.yandex|^$/ },
  { say: "Click on a radio.", expect: ["click_on"], target: "radio", env: { focusedApp: "Music", windowTitle: "Music" } },
  { say: "Click on a radio from the sidebar menu.", expect: ["click_on"], target: "radio", env: { focusedApp: "Music", windowTitle: "Music" } },
  { say: "Play a radio.", expect: ["click_on", "unknown_task"], env: { focusedApp: "Music", windowTitle: "Music" } },
  { say: "Can you up the sound?", expect: ["volume_up"] },
  { say: "Click on the next song.", expect: ["media_next", "click_on"] },
  // --- talking to apps -------------------------------------------------------
  { say: "Send a prompt to the open code saying hello.", expect: ["send_to_app"] },
  { say: "Open an open code.", expect: ["open_app"], target: "OpenCode" },
  { say: "open codex and send a prompt saying fix the tests", expect: ["open_app + send_to_app", "open_app + run_learned"] },
  // --- files ---------------------------------------------------------------
  { say: "rename the folder on the desktop to Hello World.", expect: ["rename_item"] },
  { say: "Rename the untitled folder on the desktop to a hello world.", expect: ["rename_item"] },
  { say: "And the name the folder as hello.", expect: ["rename_item"] },
  { say: "Create a new folder on the desktop.", expect: ["new_folder", "run_learned"] },
  { say: "make a new folder called reports", expect: ["new_folder"] },
  { say: "Open Downloads folder.", expect: ["open_folder", "run_learned"] },
  { say: "Scroll at the bottom.", expect: ["scroll_to_bottom"] },
  { say: "Have you created a new folder?", expect: ["explain_last"], env: { history: [{ said: "create a new folder", outcome: "ok", detail: "Made a folder “untitled folder”", at: Date.now() }] } },
  // --- the talk so far -----------------------------------------------------
  { say: "which permission do you need?", expect: ["explain_last"], env: { history: [{ said: "close notepad", outcome: "failed", detail: "Accessibility permission is needed to press keys and buttons. Grant it in Settings → Permissions.", at: Date.now() }] } },
  { say: "why did that not work", expect: ["explain_last"], env: { history: [{ said: "click hello", outcome: "failed", detail: "Couldn't find “Hello” in Safari.", at: Date.now() }] } },
  { say: "what did you just do", expect: ["explain_last"], env: { history: [{ said: "open safari", outcome: "ok", detail: "Opened Safari", at: Date.now() }] } },
  // --- what is on the screen ----------------------------------------------
  { say: "what apps are open", expect: ["list_open_apps"] },
  { say: "which apps are running right now", expect: ["list_open_apps"] },
  { say: "what's playing", expect: ["now_playing"] },
  { say: "what song is this", expect: ["now_playing"] },
  { say: "close the youtube window", expect: ["close_app_window", "close_window"], target: /Safari|^$/, env: { focusedApp: "Finder", runningApps: ["Finder", "Safari", "Music"], windowedApps: ["Finder", "Safari", "Music"], openWindows: [{ app: "Finder", title: "Documents" }, { app: "Safari", title: "YouTube" }, { app: "Music", title: "Music" }] } },
  { say: "open telegram", expect: ["open_app"], target: "Telegram" },
  // --- closing and quitting ------------------------------------------------
  { say: "close the browser.", expect: ["close_app_window"], target: "Google Chrome", env: IN_CHROME },
  { say: "close all browsers.", expect: ["quit_app", "close_app_window"], target: "Every open web browser", env: BROWSERS_OPEN },
  { say: "quit chrome", expect: ["quit_app"], target: "Google Chrome", env: BROWSERS_OPEN },
  { say: "close this window", expect: ["close_window"] },
  { say: "close it", expect: ["close_window", "close_app_window"], env: { ...IN_CHROME, recent: ["Opened Google Chrome"] } },
  // --- settings pages ------------------------------------------------------
  { say: "open bluetooth settings", expect: ["open_settings"], target: "Bluetooth" },
  { say: "open wifi settings", expect: ["open_settings"], target: "Wi-Fi" },
  { say: "turn on bluetooth", expect: ["bluetooth_on"] },
  { say: "Turn off Bluetooth.", expect: ["bluetooth_off"], env: { focusedApp: "System Settings", windowTitle: "Bluetooth" } },
  { say: "disable bluetooth", expect: ["bluetooth_off"] },
  { say: "turn off wifi", expect: ["wifi_off"] },
  { say: "turn the wifi back on", expect: ["wifi_on"] },
  { say: "go to bluetooth", expect: ["open_settings", "click_on"], target: /Bluetooth/, env: { focusedApp: "System Settings", windowTitle: "System Settings" } },
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
  const [installed, running, automations, defaultBrowser, windows] = await Promise.all([
    os.listApps(), os.runningApps(), os.listAutomations(), os.defaultBrowser(), os.openWindows().catch(() => undefined),
  ]);
  const base: Env = {
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: running,
    ...(windows ? { windowedApps: [...new Set(windows.map((w) => w.app))], openWindows: windows } : {}),
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
      // A case that names the running apps must not be contradicted by this
      // Mac's own windows: only those of the apps it names stay on screen.
      const running = c.env?.runningApps;
      const screen = running && !c.env?.windowedApps
        ? {
            windowedApps: (base.windowedApps ?? []).filter((a) => running.includes(a)),
            openWindows: (base.openWindows ?? []).filter((w) => running.includes(w.app)),
          }
        : {};
      const ctx: ActionContext = { ...base, ...screen, ...c.env, transcript: clause };
      return (settings.instantCommands ? instantRoute(clause, ctx) : null) ??
        (await route(ctx, { confidenceThreshold: settings.confidenceThreshold, offlineFallback: false }));
    };
    // As the app does: a chain is split, and each clause decided on its own.
    const clauses = splitCommands(c.say);
    const decisions = await Promise.all(clauses.map(decideOne));
    // "No command for that" is an answer too: the cue to learn one.
    const named = (x: RouteDecision) => x.action ?? (x.unknown ? "unknown_task" : null);
    const d: RouteDecision = decisions.length === 1
      ? { ...decisions[0]!, action: named(decisions[0]!) as RouteDecision["action"] }
      : {
          ...decisions.at(-1)!,
          action: decisions.map(named).join(" + ") as RouteDecision["action"],
          confidence: Math.min(...decisions.map((x) => x.confidence)),
        };
    const target = String(d.args.app ?? d.args.pane ?? d.args.url ?? d.args.target ?? d.args.query ?? "");
    const actionOk = d.action !== null && c.expect.includes(d.action);
    const targetOk =
      c.target === undefined || (typeof c.target === "string" ? target === c.target : c.target.test(target));
    const asks = d.slotConfidence !== undefined && d.slotConfidence < SLOT_CONFIDENCE_MIN;
    // "No command for that" is acted on at any confidence: it goes to the teacher.
    const acts = d.unknown === true || (d.confidence >= settings.confidenceThreshold && !d.reason && !asks);
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

  // --learn: what the teacher designs for each request Jev had no command for.
  // Nothing is executed or kept.
  if (process.argv.includes("--learn")) {
    const key = getOpenRouterKey();
    if (!key) {
      process.stdout.write("\n--learn: no OpenRouter key in Settings; skipped\n");
    } else {
      process.stdout.write(`\nLessons from ${settings.learnModel}:\n`);
      for (const c of cases.filter((x) => x.expect.includes("unknown_task"))) {
        const ctx: ActionContext = { ...base, ...c.env, transcript: c.say };
        const started = Date.now();
        try {
          const [catalog, checks] = await Promise.all([commandCatalog(ctx), lessonChecks(ctx, [])]);
          const answer = await askTeacher(
            lessonMessages({ request: c.say, catalog, apps: checks.apps, shortcuts: ctx.automations, focusedApp: ctx.focusedApp }),
            { apiKey: key, model: settings.learnModel },
          );
          const r = checkLesson(answer, checks, { request: c.say, model: settings.learnModel });
          process.stdout.write(
            `  ${c.say.padEnd(38)} ${r.ok ? `"${r.command.title}": ${summarize(r.command)}${r.command.confirm ? "  [asks first]" : ""}` : `declined — ${r.reason}`}  (${Date.now() - started} ms)\n`,
          );
        } catch (err) {
          process.stdout.write(`  ${c.say.padEnd(38)} failed — ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
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
