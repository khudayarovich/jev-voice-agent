/**
 * Realtime benchmark: how soon after you stop talking does a command run?
 *
 * Speaks a set of commands with the system voices, then replays each one
 * through the REAL pipeline — Silero VAD, whisper-server, Jev over the network
 * — at real-time pace, exactly as the microphone would deliver it. Nothing is
 * executed: the moment an action WOULD run is recorded instead.
 *
 *   npm run bench                 # the model chosen in Settings
 *   npm run bench -- small.en     # or name one
 *
 * Runs inside Electron so it uses the same network stack and the same stored
 * API key as the app itself. The key is never printed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { actsEarly, completedClauses, instantRoute, isIncomplete, stripLeadingConjunction } from "../../src/main/actions/realtime.ts";
import { clauseTail, splitCommands } from "../../src/main/actions/split.ts";
import type { ActionContext } from "../../src/main/actions/types.ts";
import { AudioPipeline, type Utterance, VAD_HANGOVER_MS } from "../../src/main/audio/pipeline.ts";
import { Vad } from "../../src/main/audio/vad.ts";
import { buildVocabularyPrompt } from "../../src/main/audio/vocabulary.ts";
import { WakeWord } from "../../src/main/audio/wake.ts";
import { WhisperEngine } from "../../src/main/audio/whisper.ts";
import * as jev from "../../src/main/jev/client.ts";
import { type RouteDecision, route } from "../../src/main/jev/router.ts";
import { platform } from "../../src/main/platform/index.ts";
import { getSettings } from "../../src/main/settings-store.ts";

const ROOT = process.env.JEV_ROOT ?? process.cwd();
// Same name as the app, so the same settings file and Keychain entry.
app.setName("jev-voice-agent");
// Paths inside the app resolve against the project, not this script's folder.
(app as unknown as { getAppPath: () => string }).getAppPath = () => ROOT;

const CASES: { text: string; expect: string[] }[] = [
  { text: "Hey Jeff, open Safari.", expect: ["open_app"] },
  { text: "Hey Jeff, open Telegram.", expect: ["open_app"] },
  { text: "Hey Jeff, mute.", expect: ["mute"] },
  { text: "Hey Jeff, set the volume to thirty percent.", expect: ["set_volume"] },
  { text: "Hey Jeff, open YouTube.", expect: ["open_url"] },
  { text: "Hey Jeff, turn on dark mode.", expect: ["dark_mode_on"] },
  { text: "Hey Jeff, open the browser.", expect: ["open_app"] },
  { text: "Hey Jeff, search for TypeScript generics.", expect: ["web_search"] },
  { text: "Hey Jeff, take a screenshot.", expect: ["screenshot_screen"] },
  { text: "Hey Jeff, open Notes and create a new note.", expect: ["open_app", "new_window"] },
];
const VOICES = (process.env.BENCH_VOICES ?? "Samantha,Daniel").split(",");
/** BENCH_ONLY=volume runs just the cases containing that text; BENCH_TRACE=1 prints the pipeline's trace. */
const ONLY = process.env.BENCH_ONLY?.toLowerCase();
const TRACE = process.env.BENCH_TRACE === "1";
const BLOCK = 1024;
const RATE = 16000;

interface Row {
  voice: string;
  said: string;
  heard: string;
  actions: string;
  ok: boolean;
  /** ms after the end of speech that each action would run. */
  at: number[];
  early: boolean;
  instant: boolean;
}

function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  let o = 12;
  while (o < buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "data") {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(o + 8 + i * 2) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error(`no audio in ${file}`);
}

/** Index of the last sample that is actually speech. */
function speechEnd(samples: Float32Array): number {
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]!) > 0.02) return i;
  return samples.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await app.whenReady();
  const settings = getSettings();
  const model = process.argv.find((a) => /^(base|small|large)/.test(a)) ?? settings.sttModel;

  const dir = path.join(app.getPath("temp"), "jev-bench");
  mkdirSync(dir, { recursive: true });
  const clips: { voice: string; text: string; expect: string[]; file: string }[] = [];
  for (const voice of VOICES) {
    for (const [i, c] of CASES.entries()) {
      if (ONLY && !c.text.toLowerCase().includes(ONLY)) continue;
      const file = path.join(dir, `${voice}-${i}.wav`);
      if (!existsSync(file)) execFileSync("/usr/bin/say", ["-v", voice, "-o", file, "--data-format=LEI16@16000", c.text]);
      clips.push({ voice, ...c, file });
    }
  }

  const os = platform();
  const [installed, running, automations] = await Promise.all([os.listApps(), os.runningApps(), os.listAutomations()]);
  const env: Omit<ActionContext, "transcript"> = {
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: running,
    installedApps: [...installed].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).map((a) => a.name),
    automations,
  };

  const speech = new WhisperEngine(model);
  process.stdout.write(`Starting ${model}… `);
  await speech.start();
  speech.setVocabulary(buildVocabularyPrompt(installed, running));
  process.stdout.write(`ready (${Math.round(speech.typicalMs)} ms/pass)\n\n`);

  const routes = new Map<string, Promise<RouteDecision>>();
  const decide = (clause: string): Promise<RouteDecision> => {
    const key = clause.toLowerCase();
    if (!routes.has(key)) {
      const ctx = { ...env, transcript: clause };
      const instant = settings.instantCommands ? instantRoute(clause, ctx) : null;
      routes.set(key, instant ? Promise.resolve(instant) : route(ctx, {
        confidenceThreshold: settings.confidenceThreshold,
        offlineFallback: true,
      }));
    }
    return routes.get(key)!;
  };

  const rows: Row[] = [];
  for (const clip of clips) {
    routes.clear();
    const audio = readWav(clip.file);
    const lead = new Float32Array(RATE); // a second of room tone first
    const tail = new Float32Array(RATE * 2.5);
    const stream = new Float32Array(lead.length + audio.length + tail.length);
    stream.set(lead, 0);
    stream.set(audio, lead.length);
    const endSample = lead.length + speechEnd(audio);

    const pipeline = new AudioPipeline(
      {
        speech,
        vad: new Vad({ minSilence: VAD_HANGOVER_MS / 1000, minSpeech: 0.25, maxSpeech: 20 }),
        makeWake: (phrases, threshold) => new WakeWord({ phrases, threshold }),
        appNames: () => installed.map((a) => a.name),
        isSelfAudioActive: () => false,
        ...(TRACE ? { trace: (event: string, data?: Record<string, unknown>) =>
          process.stdout.write(`      ${String(Date.now() - (spokeUntil || Date.now())).padStart(6)}  ${event} ${JSON.stringify(data ?? {})}\n`) } : {}),
      },
      settings,
    );
    pipeline.arm();

    let spokeUntil = 0; // wall-clock at the end of speech
    const acted: { at: number; action: string; early: boolean; instant: boolean }[] = [];
    let heard = "";
    let claimed = 0;

    const run = (d: RouteDecision, early: boolean) => {
      acted.push({ at: Date.now(), action: d.action ?? `none (${d.reason ?? "?"})`, early, instant: Boolean(d.instant) });
    };

    // As the app does: open the connection the moment anyone starts talking…
    pipeline.on("capture", () => jev.warm());

    pipeline.on("partial", ({ transcript }) => {
      // …and route what has been said so far if it already sounds complete.
      const ahead = acted.length ? clauseTail(transcript, acted.length) : stripLeadingConjunction(transcript);
      if (ahead && !isIncomplete(ahead)) for (const c of splitCommands(ahead)) void decide(c);
      const done = completedClauses(transcript);
      for (let i = claimed; i < done.length; i++) {
        claimed = i + 1;
        void decide(done[i]!).then((d) => {
          if (actsEarly(d, done[i]!, settings.confidenceThreshold)) run(d, true);
        });
      }
    });

    pipeline.on("utterance", async (u: Utterance) => {
      heard = u.transcript;
      const text = acted.length ? clauseTail(u.transcript, acted.length) : stripLeadingConjunction(u.transcript);
      const clauses = text ? splitCommands(text) : [];
      const decisions = await Promise.all(clauses.map(decide));
      const now = !u.final && clauses.every((c, i) => actsEarly(decisions[i]!, c, settings.confidenceThreshold));
      if (now) {
        if (!u.commit()) return;
      } else if (!u.final && (await u.settled) !== "final") {
        return;
      }
      for (const d of decisions) run(d, now);
    });

    // Real-time pace, as the microphone would deliver it.
    const started = Date.now();
    for (let i = 0; i * BLOCK < stream.length; i++) {
      const due = started + (i * BLOCK * 1000) / RATE;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const block = stream.subarray(i * BLOCK, (i + 1) * BLOCK);
      const pcm = new Int16Array(block.length);
      for (let j = 0; j < block.length; j++) pcm[j] = Math.round(Math.max(-1, Math.min(1, block[j]!)) * 32767);
      pipeline.acceptFrames(pcm, 0.1);
      if (!spokeUntil && (i + 1) * BLOCK >= endSample) spokeUntil = Math.round(started + (endSample * 1000) / RATE);
    }
    await sleep(1500);
    pipeline.disarm();

    const actions = acted.map((a) => a.action);
    rows.push({
      voice: clip.voice,
      said: clip.text.replace(/^Hey Jeff, /, ""),
      heard,
      actions: actions.join(" + ") || "—",
      ok: clip.expect.every((e, i) => actions[i] === e),
      at: acted.map((a) => Math.round(a.at - spokeUntil)),
      early: acted.some((a) => a.early),
      instant: acted.every((a) => a.instant) && acted.length > 0,
    });
    const r = rows.at(-1)!;
    process.stdout.write(
      `${r.ok ? "  ok " : "  MISS"}  ${r.voice.padEnd(9)} ${r.said.padEnd(42)} ` +
        `${r.at.map((ms) => `${ms >= 0 ? "+" : ""}${ms} ms`).join(", ").padEnd(18)} ` +
        `${r.instant ? "instant " : ""}${r.early ? "at-pause " : ""}${r.actions}` +
        (r.ok ? "" : `   heard "${r.heard}"`) + "\n",
    );
  }

  const last = rows.filter((r) => r.at.length).map((r) => r.at.at(-1)!).sort((a, b) => a - b);
  const q = (p: number) => last[Math.min(last.length - 1, Math.floor(p * last.length))] ?? 0;
  process.stdout.write(
    `\n${rows.filter((r) => r.ok).length}/${rows.length} correct   ` +
      `after end of speech: p50 ${q(0.5)} ms   p90 ${q(0.9)} ms   ` +
      `(model ${model}, ${Math.round(speech.typicalMs)} ms/pass)\n`,
  );
  speech.stop();
  app.exit(0);
}

main().catch((err) => {
  console.error("bench failed:", err instanceof Error ? err.message : err);
  app.exit(1);
});
