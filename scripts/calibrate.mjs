/**
 * Replays labelled transcripts through the real Jev API.
 *
 * This is how the confidence threshold gets set from evidence rather than by
 * guess: it reports routing accuracy, the confidence distribution for right vs
 * wrong answers, and what each request actually costs.
 *
 *   TYPESAFE_API_KEY=... node --experimental-strip-types scripts/calibrate.mjs
 */
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { choiceCriteria } from "../src/main/actions/registry.ts";
import { rankActions } from "../src/main/actions/rank.ts";

const RISK_LEVELS = [
  "Harmless and instantly reversible, like changing the volume or opening an app.",
  "Changes something the user would notice but can easily undo.",
  "Closes or discards work, such as quitting an app or closing a window.",
  "Destroys data permanently or interrupts the session, such as emptying the Trash or sleeping the machine.",
];

/** [transcript, expected action key or null for "not a command"] */
const CASES = [
  ["open safari", "open_app"],
  ["launch terminal", "open_app"],
  ["switch to slack", "open_app"],
  ["quit spotify", "quit_app"],
  ["hide this app", "hide_app"],
  ["set volume to thirty percent", "set_volume"],
  ["volume to 30%", "set_volume"],
  ["turn it up", "volume_up"],
  ["turn the volume down", "volume_down"],
  ["mute", "mute"],
  ["unmute", "unmute"],
  ["make the screen brighter", "brightness_up"],
  ["dim the screen", "brightness_down"],
  ["turn off the screen", "sleep_display"],
  ["lock my mac", "lock_screen"],
  ["turn on dark mode", "dark_mode_on"],
  ["switch to light mode", "dark_mode_off"],
  ["empty the trash", "empty_trash"],
  ["pause the music", "media_play_pause"],
  ["skip this song", "media_next"],
  ["go back a track", "media_previous"],
  ["copy that", "copy"],
  ["paste it", "paste"],
  ["undo that", "undo"],
  ["select everything", "select_all"],
  ["save this file", "save"],
  ["close this window", "close_window"],
  ["minimise the window", "minimize_window"],
  ["make this full screen", "fullscreen_window"],
  ["snap this to the left", "tile_window"],
  ["show me mission control", "mission_control"],
  ["show the desktop", "show_desktop"],
  ["take a screenshot", "screenshot_screen"],
  ["capture part of the screen", "screenshot_selection"],
  ["open a new tab", "new_tab"],
  ["reopen the tab i just closed", "reopen_tab"],
  ["reload the page", "reload_page"],
  ["go back", "go_back"],
  ["scroll down", "scroll_down"],
  ["scroll up a bit", "scroll_up"],
  ["go to github dot com", "open_url"],
  ["search for typescript generics", "web_search"],
  ["google the weather", "web_search"],
  ["type hello world", "type_text"],
  ["press enter", "press_enter"],
  ["never mind", "cancel"],
  ["stop listening", "stop_listening"],
  ["put the computer to sleep", "sleep_system"],
  ["do not disturb on", "do_not_disturb_on"],
  ["next window", "cycle_window"],
];

const client = new TypeSafeClient({ timeout: 15000, logLevel: "error" });
const criteria = choiceCriteria();

const results = [];
let tokens = 0;

process.stdout.write(`Running ${CASES.length} cases against ${client.defaultModel}\n\n`);

for (const [transcript, expected] of CASES) {
  const started = Date.now();
  try {
    const res = await client.systemOne({
      state: { request: transcript, focused_app: "Finder", window_title: "" },
      questions: {
        command: choice("Which single command is the user asking the computer to perform?", criteria),
        addressed: noul(
          "The user is giving a command to their computer, rather than talking to another person or thinking out loud.",
        ),
        risk: score("How much damage would be done if this request were misunderstood?", RISK_LEVELS),
      },
    });
    const ms = Date.now() - started;
    tokens += res.usage.input_tokens;
    const got = res.answers.command.choice;
    const ok = got === expected;
    results.push({ transcript, expected, got, ok, confidence: res.answers.command.confidence,
                   addressed: res.answers.addressed.noul, risk: res.answers.risk.score, ms });
    process.stdout.write(
      `${ok ? "  ok  " : "  MISS"} ${transcript.padEnd(34)} -> ${String(got).padEnd(22)}` +
      `conf ${res.answers.command.confidence.toFixed(2)}  addr ${res.answers.addressed.noul.toFixed(2)}  ` +
      `risk ${res.answers.risk.score.toFixed(1)}  ${ms}ms` +
      (ok ? "" : `   (expected ${expected})`) + "\n",
    );
  } catch (err) {
    process.stdout.write(`  ERR  ${transcript}: ${err.message}\n`);
  }
}

// --- summary ---------------------------------------------------------------
const hits = results.filter((r) => r.ok);
const misses = results.filter((r) => !r.ok);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

const localOk = CASES.filter(([t, e]) => rankActions(t, 1)[0] === e).length;

process.stdout.write("\n" + "-".repeat(74) + "\n");
process.stdout.write(`accuracy          ${pct(hits.length, results.length)}  (${hits.length}/${results.length})\n`);
process.stdout.write(`local matcher     ${pct(localOk, CASES.length)}  (the offline fallback, for comparison)\n`);
process.stdout.write(`confidence  hit   mean ${mean(hits.map((r) => r.confidence)).toFixed(3)}   p10 ${quantile(hits.map((r) => r.confidence), 0.1).toFixed(3)}\n`);
if (misses.length) {
  process.stdout.write(`confidence  miss  mean ${mean(misses.map((r) => r.confidence)).toFixed(3)}   p90 ${quantile(misses.map((r) => r.confidence), 0.9).toFixed(3)}\n`);
}
process.stdout.write(`addressed         mean ${mean(results.map((r) => r.addressed)).toFixed(3)}   min ${Math.min(...results.map((r) => r.addressed)).toFixed(3)}\n`);
process.stdout.write(`latency           mean ${Math.round(mean(results.map((r) => r.ms)))}ms   p50 ${quantile(results.map((r) => r.ms), 0.5)}ms   p95 ${quantile(results.map((r) => r.ms), 0.95)}ms\n`);
process.stdout.write(`tokens            ${tokens} total, ${Math.round(tokens / results.length)} per command\n`);
process.stdout.write(`cost              $${((tokens / 1e6) * 0.042).toFixed(6)} for this run  (~$${(((tokens / results.length) * 1000) / 1e6 * 0.042).toFixed(4)} per 1000 commands)\n`);

// Threshold sweep: what would each confidence gate cost in wrong-actions-run
// versus right-actions-refused?
process.stdout.write("\nconfidence threshold sweep\n");
for (const th of [0.3, 0.4, 0.5, 0.55, 0.6, 0.7, 0.8]) {
  const ran = results.filter((r) => r.confidence >= th);
  const wrongRun = ran.filter((r) => !r.ok).length;
  const rightRefused = hits.filter((r) => r.confidence < th).length;
  process.stdout.write(
    `  >= ${th.toFixed(2)}   runs ${String(ran.length).padStart(2)}/${results.length}   ` +
    `wrong actions run ${wrongRun}   correct ones refused ${rightRefused}\n`,
  );
}
