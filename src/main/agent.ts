import { globalShortcut } from "electron";
import { randomUUID } from "node:crypto";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings, CommandLogEntry } from "../shared/types.ts";
import { ALL_BROWSERS, expandApps, isBrowser, listNames } from "./actions/apps.ts";
import { landedOn } from "./actions/browsing.ts";
import { execute, isDismissal, missingSlots, readClarification, readConfirmation } from "./actions/execute.ts";
import { rankActions } from "./actions/rank.ts";
import {
  ADDRESSED_MIN,
  SLOT_CONFIDENCE_MIN,
  actsEarly,
  completedClauses,
  instantRoute,
  isIncomplete,
  stripLeadingConjunction,
} from "./actions/realtime.ts";
import { ACTIONS, type ActionKey } from "./actions/registry.ts";
import { appUniverse } from "./actions/slots.ts";
import { clauseTail, splitCommands } from "./actions/split.ts";
import type { ActionContext, ActionResult } from "./actions/types.ts";
import { downloadModel, isInstalled } from "./audio/download.ts";
import { modelById } from "./audio/models.ts";
import { AudioPipeline, type TriggerKind, type Utterance, VAD_HANGOVER_MS } from "./audio/pipeline.ts";
import { Vad } from "./audio/vad.ts";
import { buildVocabularyPrompt } from "./audio/vocabulary.ts";
import { WakeWord } from "./audio/wake.ts";
import { WhisperEngine } from "./audio/whisper.ts";
import { coordinator } from "./coordinator.ts";
import { isSelfAudioActive, play } from "./earcons.ts";
import * as jev from "./jev/client.ts";
import { type RouteDecision, route } from "./jev/router.ts";
import { log as fileLog } from "./log.ts";
import { platform } from "./platform/index.ts";
import { getSettings } from "./settings-store.ts";
import { broadcast, createCapture, getCapture, hideHud, showHud } from "./windows.ts";

/**
 * Owns the listening lifecycle — the speech engine, the pipeline, the hotkey —
 * and turns what the user says into actions, as early as it safely can.
 *
 * The pipeline hands over an utterance the moment the user pauses. This routes
 * it straight away (context gathered while they were still talking, the
 * connection to Jev already warm), and if the answer is a complete, confident
 * command it runs it then and there, without waiting for the silence to be
 * long enough to be sure they are done. Finished clauses of a chain run even
 * earlier, while the rest is still being said.
 */

let speech: WhisperEngine | null = null;
let pipeline: AudioPipeline | null = null;
let registeredHotkey = "";
/** Cached app names, used to repair mangled proper nouns in transcripts. */
let knownAppNames: string[] = [];
let starting: Promise<void> | null = null;

export function getPipeline(): AudioPipeline | null {
  return pipeline;
}

export async function startListening(): Promise<void> {
  if (pipeline?.listening) return;
  if (starting) return starting;
  starting = doStart().finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart(): Promise<void> {
  const settings = getSettings();
  fileLog("agent", "starting", { wakeWords: settings.wakeWords, hotkey: settings.hotkey });
  coordinator.setState("thinking", "Starting speech engine…");
  // The first command should not pay for the TLS handshake either.
  jev.warm();

  try {
    // A model change means a different server process, so rebuild rather than
    // reuse.
    if (speech && speech.model !== settings.sttModel) {
      speech.stop();
      speech = null;
    }
    await ensureModel(settings.sttModel);
    if (!speech) {
      speech = new WhisperEngine(settings.sttModel, { trace: (event, data) => fileLog("whisper", event, data ?? {}) });
    }
    // This also forces the one-time Metal shader compile, which takes ~17 s on a
    // cold machine. Far better to pay it here than on the first spoken command.
    await speech.start();
  } catch (err) {
    coordinator.setState("error", err instanceof Error ? err.message : String(err));
    coordinator.setListening(false);
    return;
  }

  const vad = new Vad({ minSilence: VAD_HANGOVER_MS / 1000, minSpeech: 0.25, maxSpeech: 20 });
  pipeline = new AudioPipeline(
    {
      speech,
      vad,
      makeWake: (phrases, threshold) => new WakeWord({ phrases, threshold }),
      appNames: () => knownAppNames,
      isSelfAudioActive,
      trace: (event, data) => fileLog("pipeline", event, data ?? {}),
    },
    settings,
  );
  wirePipeline(pipeline);
  pipeline.arm();

  // Tell the recogniser what vocabulary to expect. This is the single most
  // effective accuracy lever available: measured over a set of spoken commands
  // it more than halved word error rate, because nearly every failure is a
  // proper noun — an app name the model had no reason to consider.
  void primeVocabulary();
  void refreshEnv();

  createCapture();
  // The capture window may still be loading; retry until it takes the message.
  await sendCaptureStart(settings.inputDeviceId);

  registerHotkey(settings.hotkey);
  fileLog("agent", "armed", {
    wakeAvailable: pipeline.wakeAvailable,
    unsupportedPhrases: pipeline.unsupportedWakePhrases,
    streaming: pipeline.streaming,
    engineMs: Math.round(speech.typicalMs),
  });
  coordinator.setListening(true);
  coordinator.setState("idle");
}

export function stopListening(): void {
  pipeline?.disarm();
  pipeline = null;
  pending = null;
  clarifying = null;
  sessions.clear();
  recent.length = 0;
  getCapture()?.webContents.send(IPC.captureStop);
  unregisterHotkey();
  hideHud();
  coordinator.setListening(false);
}

export function shutdown(): void {
  stopListening();
  speech?.stop();
  speech = null;
}

export function applySettings(next: AppSettings): void {
  pipeline?.updateSettings(next);
  if (speech && speech.model !== next.sttModel && pipeline?.listening) {
    // Swap the speech model without making the user toggle listening off and on.
    fileLog("agent", "model-change", { from: speech.model, to: next.sttModel });
    stopListening();
    void startListening();
    return;
  }
  if (next.hotkey !== registeredHotkey && pipeline?.listening) registerHotkey(next.hotkey);
}

/**
 * A fresh install has no speech model yet: fetch it now, visibly, rather than
 * fail. If the app already started the download at launch this joins it.
 */
async function ensureModel(id: string): Promise<void> {
  const model = modelById(id);
  if (isInstalled(model)) return;
  fileLog("agent", "model-download", { model: id });
  showHud();
  await downloadModel(id, (p) => {
    broadcast(IPC.sttDownloadProgress, p);
    if (p.done || !p.totalBytes) return;
    const pct = Math.round((p.receivedBytes / p.totalBytes) * 100);
    coordinator.setState("thinking", `Downloading the ${model.label} speech model… ${pct}%`);
  });
  hideHud();
  if (!isInstalled(model)) {
    throw new Error(`Could not download the ${model.label} speech model. Check your connection and try again.`);
  }
}

/** Seed the recogniser with the apps actually installed on this Mac. */
async function primeVocabulary(): Promise<void> {
  if (!speech?.setVocabulary) return;
  try {
    const os = platform();
    const [installed, running] = await Promise.all([
      os.listApps().catch(() => []),
      os.runningApps().catch(() => [] as string[]),
    ]);
    knownAppNames = installed.map((a) => a.name);
    const prompt = buildVocabularyPrompt(installed, running);
    speech.setVocabulary(prompt);
    fileLog("agent", "vocabulary", { apps: installed.length, chars: prompt.length });
  } catch (err) {
    fileLog("agent", "vocabulary-failed", { message: describe(err) });
  }
}

async function sendCaptureStart(deviceId: string): Promise<void> {
  const win = createCapture();
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  }
  win.webContents.send(IPC.captureStart, deviceId);
}

// ---------------------------------------------------------------------------
// What is in front of the user
// ---------------------------------------------------------------------------

/** Everything the router needs except the words themselves. */
type Env = Omit<ActionContext, "transcript">;

let env: { at: number; value: Promise<Env> } | null = null;

/**
 * Gather context now, so it is ready when the transcript is.
 *
 * Called when a command starts and again when the user pauses: the four
 * lookups run while they are still talking, instead of after, where they used
 * to add ~330 ms to every command. All of them are tolerant of failure — a
 * missing grant must degrade the context, never block the command.
 *
 * Everything here is gathered by this app from the OS. Nothing that came from a
 * web page, the clipboard, or the screen goes anywhere near it — Jev is
 * documented as steerable by instructions injected into its state.
 */
function refreshEnv(): Promise<Env> {
  const os = platform();
  const value = Promise.all([
    os.focus().catch(() => ({ app: "", windowTitle: "" })),
    os.runningApps().catch(() => [] as string[]),
    os.listApps().catch(() => []),
    os.listAutomations().catch(() => [] as string[]),
    os.defaultBrowser().catch(() => ""),
    os.windowedApps().catch(() => undefined),
  ]).then(([focus, running, installed, automations, defaultBrowser, windowed]) => ({
    focusedApp: focus.app,
    windowTitle: focus.windowTitle ?? "",
    runningApps: running,
    ...(windowed ? { windowedApps: windowed } : {}),
    // Most recently used first: when nothing was named and the router has to
    // offer a list, the likely answers should be at the top of it.
    installedApps: [...installed]
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name))
      .map((a) => a.name),
    automations,
    ...(defaultBrowser ? { defaultBrowser } : {}),
  }));
  env = { at: Date.now(), value };
  return value;
}

function currentEnv(): Promise<Env> {
  if (env && Date.now() - env.at < 4000) return env.value;
  return refreshEnv();
}

// ---------------------------------------------------------------------------
// What the conversation has done so far
// ---------------------------------------------------------------------------

/**
 * The agent's short-term memory: what it just did, and the browser in use.
 *
 * Without it every command stood alone, and it showed: "open my browser"
 * opened Chrome, then "search for YouTube" opened Safari, because the search
 * had no idea a browser had just been opened. Commands now carry what was just
 * done, in the context each one is decided and run with.
 */
const recent: { at: number; detail: string }[] = [];
let lastBrowser: { name: string; at: number } | null = null;
let lastPage: { url: string; at: number } | null = null;

/** Actions older than this are not "just now" any more. */
const RECENT_MS = 3 * 60_000;
/** A browser last used longer ago than this counts only if it is still open. */
const BROWSER_MEMORY_MS = 30 * 60_000;

function remember(action: ActionKey, args: Record<string, string | number>, result: ActionResult, e: Env): void {
  const now = Date.now();
  recent.push({ at: now, detail: result.detail ?? phrase(action) });
  while (recent.length > 4) recent.shift();
  if (result.app && isBrowser(result.app)) lastBrowser = { name: result.app, at: now };
  if (result.page) lastPage = { url: result.page, at: now };
  if (action === "quit_app" && lastBrowser && expandApps(String(args.app), e.runningApps).includes(lastBrowser.name)) {
    lastBrowser = null;
  }
}

/** The environment, plus what this conversation has already done. */
function withMemory(e: Env): Env {
  const now = Date.now();
  const done = recent.filter((r) => now - r.at < RECENT_MS).map((r) => r.detail);
  const browser =
    lastBrowser && (now - lastBrowser.at < BROWSER_MEMORY_MS || e.runningApps.includes(lastBrowser.name))
      ? lastBrowser.name
      : undefined;
  const page = lastPage && now - lastPage.at < RECENT_MS ? lastPage.url : undefined;
  return {
    ...e,
    ...(done.length ? { recent: done } : {}),
    ...(browser ? { lastBrowser: browser } : {}),
    ...(page ? { lastPage: page } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routing, cached
// ---------------------------------------------------------------------------

/**
 * Bumps whenever an action runs, since that can change what is in front — a
 * decision made before "open Safari" ran is not necessarily right after it.
 */
let worldVersion = 0;
const routes = new Map<string, { at: number; decision: Promise<RouteDecision> }>();

const normalize = (s: string) =>
  s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Route one clause — once. The same words heard at a pause and again at the
 * end of the utterance share one request, so the answer is usually already
 * here by the time the utterance is known to be over.
 */
function decide(clause: string, e: Env): Promise<RouteDecision> {
  const key = `${worldVersion}|${normalize(clause)}`;
  const hit = routes.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.decision;
  for (const [k, v] of routes) if (Date.now() - v.at > 15_000) routes.delete(k);

  const ctx: ActionContext = { ...withMemory(e), transcript: clause };
  const settings = getSettings();
  const instant = settings.instantCommands ? instantRoute(clause, ctx) : null;
  const decision = (instant
    ? Promise.resolve(instant)
    : route(ctx, {
        confidenceThreshold: settings.confidenceThreshold,
        offlineFallback: settings.offlineFallback,
      })
  )
    .catch((err): RouteDecision => ({
      action: null, args: {}, confidence: 0, addressed: 1, risk: 0,
      offline: false, ms: 0, inputTokens: 0, reason: describe(err),
    }))
    .then((d) => {
      fileLog("route", "decision", {
        transcript: clause,
        action: d.action,
        args: d.args,
        confidence: Number(d.confidence.toFixed(3)),
        ...(d.slotConfidence !== undefined ? { slotConfidence: Number(d.slotConfidence.toFixed(3)) } : {}),
        ...(d.alternative ? { alternative: d.alternative } : {}),
        addressed: Number(d.addressed.toFixed(3)),
        risk: Number(d.risk.toFixed(2)),
        offline: d.offline,
        instant: d.instant ?? false,
        routeMs: d.ms,
        inputTokens: d.inputTokens,
        reason: d.reason,
      });
      return d;
    });
  routes.set(key, { at: Date.now(), decision });
  return decision;
}

// ---------------------------------------------------------------------------
// Pipeline → actions
// ---------------------------------------------------------------------------

/** One capture's worth of commands. */
interface Session {
  id: number;
  /** Clauses already run from partial transcripts, mid-sentence. */
  ran: string[];
  /** How many completed clauses have been claimed for early running. */
  claimed: number;
  /** Early clause runs still in progress. */
  early: Promise<void>[];
  /** Stop running clauses early: one failed, or needs a yes, or was unsure. */
  halted: boolean;
  /** Only the newest utterance of a capture may act. */
  generation: number;
  finished: boolean;
}
const sessions = new Map<number, Session>();

function sessionFor(id: number): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { id, ran: [], claimed: 0, early: [], halted: false, generation: 0, finished: false };
    sessions.set(id, s);
    // Captures are short-lived; keep only the recent ones.
    for (const old of sessions.keys()) if (old < id - 8) sessions.delete(old);
  }
  return s;
}

/** Executions happen one at a time, in the order they were decided. */
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** Bumps on every new capture, so a stale "back to idle" timer cannot hide it. */
let hudEpoch = 0;

function wirePipeline(p: AudioPipeline): void {
  p.on("level", (level) => coordinator.setLevel(level));

  // Frame accounting, sampled. Silence in this line means capture is dead, which
  // is otherwise indistinguishable from "nobody spoke".
  let frames = 0;
  let peak = 0;
  p.on("level", (level) => {
    frames++;
    peak = Math.max(peak, level);
    if (frames % 100 === 0) {
      fileLog("capture", "frames", { frames, peakLevel: Number(peak.toFixed(3)) });
      peak = 0;
    }
  });

  // Someone started talking. It may not be for us, but opening the connection
  // costs nothing and saves a handshake if it is.
  p.on("capture", () => jev.warm());

  p.on("trigger", (kind: TriggerKind) => {
    fileLog("pipeline", "trigger", { kind });
    hudEpoch++;
    void refreshEnv();
    jev.warm();
    // Only the hotkey gets a cue here: after a wake word the user is usually
    // still talking, and a tone over their words helps nobody.
    if (kind === "hotkey") play("wake");
    showHud();
    coordinator.setTranscript("", false);
    coordinator.setState(
      "listening",
      kind === "hotkey" ? "Listening (hotkey)…" : kind === "followup" ? "Go ahead…" : "Listening…",
    );
  });

  p.on("partial", ({ captureId, transcript }) => {
    coordinator.setTranscript(transcript, true);
    const s = sessionFor(captureId);
    runFinishedClauses(s, transcript);
    routeAhead(s, transcript);
  });

  // They paused: look at the screen again now, while the pause is transcribed.
  p.on("pause", () => void refreshEnv());

  p.on("endpoint", () => {
    fileLog("pipeline", "endpoint");
  });

  p.on("cancelled", (reason) => {
    fileLog("pipeline", "cancelled", { reason });
    // Speech that was not addressed to us is the normal case, not an error:
    // while armed, the agent transcribes anything it hears and simply discards
    // what does not open with the wake phrase. It must do that silently.
    const routine = reason === "no speech" || reason === "not addressed" || reason === "too short";
    // A dropped speculative capture was never on screen, and must not clear the
    // result of the command that is.
    if (routine && coordinator.getState() !== "listening") return;
    coordinator.setState(p.inFollowUp ? "conversing" : "idle");
    coordinator.setTranscript("", false);
    if (!p.inFollowUp) hideHud();
    if (!routine) play("cancel");
  });

  // The wake phrase with no command after it: acknowledge and wait.
  p.on("prompt", () => {
    fileLog("pipeline", "prompt", {});
    play("wake");
    openConversation();
    coordinator.setTranscript("", false);
    coordinator.setState("conversing", "Go ahead…");
    showHud();
  });

  p.on("error", (err) => {
    fileLog("pipeline", "error", { message: err.message });
    play("error");
    coordinator.setState("error", err.message);
    log({ transcript: "", action: null, outcome: "failed", detail: err.message });
    setTimeout(() => coordinator.setState("idle"), 2500);
  });

  p.on("followUpEnded", (reason: string) => {
    fileLog("agent", "conversation-ended", { reason });
    // A new conversation starts with a clean slate: "close it" in the next one
    // must not reach back to what this one did.
    recent.length = 0;
    // A question nobody answered lapses with the conversation. Left pending, it
    // kept the overlay asking "Quit Safari?" until the user next spoke.
    if (pending || clarifying) {
      fileLog("route", "question-unanswered", { action: pending?.action ?? clarifying?.decision.action });
      pending = null;
      clarifying = null;
    }
    const state = coordinator.getState();
    if (state === "conversing" || state === "confirming") {
      coordinator.setState("idle");
      coordinator.setTranscript("", false);
      hideHud();
    }
  });

  p.on("utterance", (u: Utterance) => {
    void onUtterance(u).catch((err) => fileLog("agent", "utterance-failed", { message: describe(err) }));
  });
}

/**
 * Run the finished clauses of a chain while the rest is still being said.
 *
 * "open Notes and create a new note": the moment a partial transcript shows
 * "open Notes and …", Notes opens. Only clauses followed by more speech count,
 * and only confident, harmless ones run — anything else stops early running for
 * this capture, and the whole utterance is judged normally at the end.
 */
function runFinishedClauses(s: Session, partial: string): void {
  if (!getSettings().realtime || s.halted || s.finished || pending) return;
  const done = completedClauses(partial);
  for (let i = s.claimed; i < done.length; i++) {
    const clause = done[i]!;
    s.claimed = i + 1;
    // Routed at once, in parallel with anything before it — but run strictly
    // after it. A later clause that routes faster (an instant command behind
    // one waiting on Jev) must not overtake: "open Safari and go to GitHub"
    // would otherwise go to GitHub first.
    const decided = currentEnv().then((e) => decide(clause, e).then((d) => ({ d, e })));
    const previous = s.early.at(-1) ?? Promise.resolve();
    s.early.push(previous.then(() => runEarly(s, clause, decided)));
  }
}

/**
 * Start routing what has been said so far, before the user stops.
 *
 * A partial transcript is often already the whole command — "set the volume to
 * 30%" is complete a beat before the speaker falls silent. Routing it now means
 * the answer is waiting when the pause's transcription confirms the same words,
 * instead of the ~300 ms round trip starting only then. Words that sound
 * unfinished are not worth a request.
 */
function routeAhead(s: Session, partial: string): void {
  if (!getSettings().realtime || s.finished || pending) return;
  const text = s.ran.length ? clauseTail(partial, s.ran.length) : stripLeadingConjunction(partial);
  if (!text || isIncomplete(text)) return;
  void currentEnv().then((e) => {
    for (const clause of splitCommands(text)) void decide(clause, e);
  });
}

async function runEarly(
  s: Session,
  clause: string,
  decided: Promise<{ d: RouteDecision; e: Env }>,
): Promise<void> {
  const { d, e } = await decided;
  await serially(async () => {
    if (s.halted || s.finished) return;
    if (!actsEarly(d, clause, getSettings().confidenceThreshold) || needsConfirmation(d)) {
      s.halted = true;
      return;
    }
    const r = await act(d, e, true, clause);
    fileLog("agent", "ran-early", { clause, action: d.action, outcome: r.outcome, detail: r.detail });
    if (r.outcome !== "ok") {
      s.halted = true;
      return;
    }
    s.ran.push(r.detail);
    coordinator.setState("executing", r.detail);
  });
}

/** A destructive action waiting for the user to say yes. */
interface Pending {
  action: ActionKey;
  args: Record<string, string | number>;
  ctx: ActionContext;
  transcript: string;
  askedAt: number;
}
let pending: Pending | null = null;

/** Confirmations go stale — never run something the user agreed to a minute ago. */
const CONFIRM_WINDOW_MS = 15_000;

/**
 * A question about which one the user meant — "Xcode or Cursor?" — waiting
 * for its answer. The answer ("Cursor") completes the original command
 * rather than being taken as a new one: "quit my editor", then "Cursor", must
 * quit Cursor, not open it.
 */
interface Clarifying {
  decision: RouteDecision;
  /** The slot being asked about, e.g. "app". */
  slot: string;
  options: string[];
  transcript: string;
  env: Env;
  askedAt: number;
}
let clarifying: Clarifying | null = null;

async function onUtterance(u: Utterance): Promise<void> {
  const s = sessionFor(u.captureId);
  const generation = ++s.generation;
  hudEpoch++;
  fileLog("pipeline", "utterance", {
    transcript: u.transcript,
    raw: u.raw,
    trigger: u.trigger,
    final: u.final,
    transcribeMs: u.transcribeMs,
    durationSec: Number(u.durationSec.toFixed(2)),
  });
  coordinator.setTranscript(u.transcript, !u.final);

  // A question the agent asked takes priority over routing anything new —
  // unless what was said is not an answer at all, but a new command.
  if (pending && (await answerConfirmation(u, s))) return;
  if (clarifying && (await answerClarification(u, s))) return;

  // "that's it, thank you" ends the conversation. Checked before routing: it is
  // instant, unambiguous, and sending it to the router would only invite it to
  // be read as some command or other.
  if (pipeline?.inFollowUp && isDismissal(u.transcript)) {
    if (!(await claimNow(u, generation, s))) return;
    fileLog("agent", "dismissed", { said: u.transcript });
    pipeline?.closeFollowUp("dismissed");
    recent.length = 0;
    finish(u, s, { outcome: "cancelled", action: null, detail: "Okay", decision: null }, { silent: false, conversation: "close" });
    return;
  }

  // Clauses already run mid-sentence are not run again.
  await Promise.all(s.early);
  if (generation !== s.generation || s.finished) return;
  const text = s.ran.length ? clauseTail(u.transcript, s.ran.length) : stripLeadingConjunction(u.transcript);
  const clauses = text ? splitCommands(text) : [];

  if (clauses.length === 0) {
    if (!(await claim(u, generation, s))) return;
    if (s.ran.length) finish(u, s, { outcome: "ok", action: null, detail: s.ran.join(", "), decision: null });
    else finish(u, s, { outcome: "rejected", action: null, detail: "Nothing to do", decision: null });
    return;
  }
  if (clauses.length > 1) fileLog("route", "split", { parts: clauses });
  if (u.final) coordinator.setState("thinking", "Working out what you meant…");

  const e = await currentEnv();
  const decisions = await Promise.all(clauses.map((c) => decide(c, e)));
  if (generation !== s.generation || s.finished) return;

  // Act now, or wait for the silence to say they are done?
  const now =
    getSettings().realtime &&
    !u.final &&
    clauses.every((c, i) => actsEarly(decisions[i]!, c, getSettings().confidenceThreshold));
  if (now) {
    // False when they have already started talking again: a longer utterance
    // is on its way, and it will reuse these routes if the words match.
    if (!u.commit()) return;
  } else if (!(await claim(u, generation, s))) {
    return;
  }

  await serially(() => runClauses(u, s, clauses, decisions, e, now));
}

/**
 * Wait until the utterance is known to be over — the silence ran out — and
 * make sure it is still the one to act on. False means the user went on
 * speaking and a longer utterance has replaced it.
 */
async function claim(u: Utterance, generation: number, s: Session): Promise<boolean> {
  if (!u.final && (await u.settled) !== "final") return false;
  return generation === s.generation && !s.finished;
}

/** Take it at this pause if they are still quiet; otherwise wait as `claim` does. */
async function claimNow(u: Utterance, generation: number, s: Session): Promise<boolean> {
  if (u.commit()) return generation === s.generation && !s.finished;
  return claim(u, generation, s);
}

/** Run the decided clauses in order; stop at the first that does not succeed. */
async function runClauses(
  u: Utterance,
  s: Session,
  clauses: string[],
  decisions: RouteDecision[],
  e: Env,
  early: boolean,
): Promise<void> {
  if (s.finished) return;
  const done = [...s.ran];
  let last: Outcome | null = null;

  for (let i = 0; i < clauses.length; i++) {
    const d = decisions[i]!;
    const r = await act(d, e, i < clauses.length - 1, clauses[i]!);
    last = r;

    if (r.confirm) {
      // Stop here rather than queueing the rest: asking "empty the Trash?" and
      // then silently running two more commands afterwards would be startling.
      s.finished = true;
      const ctx = { ...withMemory(e), transcript: clauses[i]! };
      clarifying = null;
      pending = { ...r.confirm, ctx, transcript: clauses[i]!, askedAt: Date.now() };
      const question = confirmQuestion(r.confirm.action, r.confirm.args, ctx);
      coordinator.setState("confirming", `${question} Say yes to confirm.`);
      play("confirm");
      showHud();
      // Hold the conversation open, or answering "yes" would mean saying the
      // wake word again first - absurd for a question the agent just asked.
      openConversation(CONFIRM_WINDOW_MS);
      fileLog("route", "awaiting-confirmation", { action: r.confirm.action, question });
      return;
    }

    if (r.clarify) {
      // Ask which one, and hold the conversation open for the answer.
      s.finished = true;
      pending = null;
      clarifying = { decision: d, ...r.clarify, transcript: clauses[i]!, env: e, askedAt: Date.now() };
      coordinator.setState("confirming", r.detail);
      play("confirm");
      showHud();
      openConversation(CONFIRM_WINDOW_MS);
      fileLog("route", "awaiting-clarification", { action: d.action, options: r.clarify.options });
      return;
    }

    if (r.outcome !== "ok") {
      // Report what did run before the failure, so a half-done chain is visible.
      const detail = done.length ? `${done.join(", ")} — then: ${r.detail}` : r.detail;
      const quiet = r.outcome === "cancelled" && !done.length;
      finish(u, s, { ...r, detail }, { silent: quiet, conversation: quiet ? "leave" : "open", early });
      return;
    }
    done.push(r.detail);
  }

  finish(u, s, { outcome: "ok", action: last?.action ?? null, detail: done.join(", ") || "Done", decision: last?.decision ?? null }, { early });
}

/** What acting on one decision produced. */
interface Outcome {
  outcome: "ok" | "rejected" | "failed" | "cancelled";
  action: ActionKey | null;
  detail: string;
  decision: RouteDecision | null;
  /** Set when the action needs a spoken yes before it may run. */
  confirm?: { action: ActionKey; args: Record<string, string | number> };
  /** Set when it is unclear which one the user meant: ask, with these options. */
  clarify?: { slot: string; options: string[] };
  execMs?: number;
}

function needsConfirmation(d: RouteDecision): boolean {
  if (!d.action || !getSettings().confirmDestructive) return false;
  // Gated on BOTH the registry flag and the model's own read of how much damage
  // a misunderstanding would do — and, for a click, on what is being clicked.
  const def = ACTIONS[d.action] as { destructive?: boolean; confirmIf?: (args: Record<string, string | number>) => boolean };
  return def.destructive === true || def.confirmIf?.(d.args) === true || d.risk >= 2.5;
}

/**
 * Turn one routing decision into an outcome: run it, refuse it, or ask first.
 * `more` says another clause follows, so wait for focus to settle.
 */
async function act(d: RouteDecision, e: Env, more: boolean, clause: string): Promise<Outcome> {
  // Not addressed to the agent - most likely a false wake while the user was
  // talking to someone else.
  if (d.addressed < ADDRESSED_MIN) {
    return { outcome: "cancelled", action: null, detail: "not addressed to the agent", decision: d };
  }
  if (!d.action) {
    return { outcome: "rejected", action: null, detail: sentence(d.reason) ?? "No matching command", decision: d };
  }
  const missing = missingSlots(d.action, d.args);
  if (missing.length > 0) {
    return {
      outcome: "rejected",
      action: d.action,
      detail: sentence(d.reason) ?? `Could not work out the ${missing.join(" and ")}`,
      decision: d,
    };
  }
  // Confidence gate. Jev reports calibrated confidence, and a 50-command
  // calibration run put correct answers at a mean of 0.98 and wrong ones at
  // 0.53 - so this threshold is a real dial, not a guess.
  if (d.confidence < getSettings().confidenceThreshold) {
    return {
      outcome: "rejected",
      action: d.action,
      detail: `Not sure enough — did you mean to ${phrase(d.action).toLowerCase()}?`,
      decision: d,
    };
  }
  // The command is clear but which one is not: "open my code editor" with
  // Xcode and Cursor both installed. Asking beats opening the wrong one.
  if (d.slotConfidence !== undefined && d.slotConfidence < SLOT_CONFIDENCE_MIN) {
    const slot = d.unsureSlot ?? "app";
    const picked = String(d.args[slot] ?? "");
    const options = [picked, d.alternative].filter((o): o is string => Boolean(o));
    return {
      outcome: "rejected",
      action: d.action,
      detail: options.length > 1 ? `Which one — ${options[0]} or ${options[1]}?` : `Did you mean ${picked}?`,
      decision: d,
      clarify: { slot, options },
    };
  }
  if (needsConfirmation(d)) {
    return {
      outcome: "cancelled", action: d.action, detail: "awaiting confirmation", decision: d,
      confirm: { action: d.action, args: d.args },
    };
  }
  // The words go along: "open YouTube in Chrome" names the browser, and
  // "search YouTube for cats" the site, in words no slot holds.
  return run(d.action, d.args, { ...withMemory(e), transcript: clause }, d, more);
}

async function run(
  action: ActionKey,
  args: Record<string, string | number>,
  ctx: ActionContext,
  decision: RouteDecision | null,
  more: boolean,
): Promise<Outcome> {
  coordinator.setState("executing", phrase(action));
  const os = platform();
  const started = Date.now();
  const before = more ? await os.frontApp().catch(() => "") : "";
  try {
    const result = await execute(action, args, os, ctx);
    const execMs = Date.now() - started;
    fileLog("execute", "ok", { action, args, execMs, ...(result.app ? { app: result.app } : {}) });
    worldVersion++;
    remember(action, args, result, ctx);
    // A couple of actions steer the agent itself rather than the OS.
    if (action === "stop_listening") stopListening();
    // Another command follows: let the app just opened actually come to the
    // front first, or "open Safari and open a new tab" sends its Cmd-T to
    // whatever was in front a moment ago.
    if (more) await settleFocus(action, result.app, before, result.page);
    return { outcome: "ok", action, detail: result.detail ?? phrase(action), decision, execMs };
  } catch (err) {
    fileLog("execute", "failed", { action, args, message: describe(err) });
    return { outcome: "failed", action, detail: describe(err), decision };
  }
}

async function settleFocus(action: ActionKey, app: string | undefined, before: string, page?: string): Promise<void> {
  const os = platform();
  if (app) {
    // The app it opened or used, whichever that was: a browser for a link, the
    // app itself for "open", Photo Booth for a photo. Already in front: done.
    if (app !== before) await os.waitForFrontmost((a) => a === app, 1500);
  } else if (action === "open_url" || action === "web_search") {
    // The browser comes forward — unless it already was in front.
    await os.waitForFrontmost((a) => a !== before, 600);
  }
  // And the page itself has to arrive: "search for cats and click the first
  // result" must click among these results, not the ones already on screen.
  if (app && page && (action === "open_url" || action === "web_search")) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const tab = await os.browserTab(app).catch(() => null);
      if (!tab || landedOn(tab.url, page)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  void refreshEnv();
}

/**
 * Settle the question the agent asked. Returns false when what was said is no
 * answer but a new command, which the caller then routes as usual.
 */
async function answerConfirmation(u: Utterance, s: Session): Promise<boolean> {
  const held = pending!;
  const generation = s.generation;

  if (Date.now() - held.askedAt > CONFIRM_WINDOW_MS) {
    pending = null;
    // Too late to be an answer. A new command is still a command, though.
    if (readConfirmation(u.transcript) === "unclear" && rankActions(u.transcript, 1).length > 0) return false;
    finish(u, s, { outcome: "cancelled", action: held.action, detail: "Confirmation expired", decision: null });
    return true;
  }

  let answer = readConfirmation(u.transcript);
  // Saying the same thing again is how people insist. Observed in real use:
  // asked "Quit app? Say yes to confirm", the reply was the original command
  // repeated, which read as "unclear" and cancelled. Repetition is agreement.
  if (answer === "unclear" && repeatsRequest(u.transcript, held)) answer = "yes";

  // A clear yes or no can be taken at the first pause. Anything else waits for
  // the end of what they are saying — they may still be getting to the point.
  const ok = answer !== "unclear" ? await claimNow(u, generation, s) : await claim(u, generation, s);
  if (!ok) return true;
  if (pending !== held) return true;
  pending = null;

  fileLog("route", "confirmation", { action: held.action, answer, said: u.transcript });

  if (answer === "yes") {
    const r = await serially(() => run(held.action, held.args, held.ctx, null, false));
    const stops = held.action === "stop_listening" || held.action === "cancel";
    finish(u, s, r, { conversation: stops ? "close" : "open" });
    return true;
  }
  // A different command instead of an answer. Observed in real use: asked to
  // confirm quitting, the user said "close the browser" — which meant do that
  // instead, and was swallowed as "not confirmed". The destructive thing still
  // does not happen; the new command gets routed like any other.
  if (answer === "unclear" && rankActions(u.transcript, 1).length > 0) {
    fileLog("route", "confirmation-superseded", { action: held.action, said: u.transcript });
    return false;
  }
  // Anything else that is not a clear yes is a no: silence, a mumble.
  finish(u, s, {
    outcome: "cancelled", action: held.action,
    detail: answer === "no" ? "Cancelled" : "Not confirmed", decision: null,
  });
  return true;
}

/**
 * Settle "which one did you mean?". Returns false when what was said is no
 * answer but a new command, which the caller then routes as usual.
 */
async function answerClarification(u: Utterance, s: Session): Promise<boolean> {
  const held = clarifying!;
  const generation = s.generation;
  if (Date.now() - held.askedAt > CONFIRM_WINDOW_MS) {
    clarifying = null;
    return false;
  }

  const top = rankActions(u.transcript, 1)[0];
  const others = held.slot === "app" ? appUniverse(held.env) : [];
  const answer = readClarification(u.transcript, held.options, others, top !== undefined && top !== held.decision.action);
  if (answer.kind === "new") {
    clarifying = null;
    fileLog("route", "clarification-superseded", { action: held.decision.action, said: u.transcript });
    return false;
  }

  if (!(await claimNow(u, generation, s))) return true;
  if (clarifying !== held) return true;
  clarifying = null;
  fileLog("route", "clarification", {
    action: held.decision.action,
    answer: answer.kind === "pick" ? answer.value : "cancel",
    said: u.transcript,
  });

  if (answer.kind === "cancel") {
    finish(u, s, { outcome: "cancelled", action: held.decision.action, detail: "Cancelled", decision: null });
    return true;
  }
  // Routing checked this for the app it guessed; the one chosen now needs the
  // same check, or "quit" would launch an app just to quit it.
  const action = held.decision.action!;
  const slot = (ACTIONS[action].slots as Record<string, { requiresRunning?: boolean }>)[held.slot];
  const running = held.env.runningApps;
  if (slot?.requiresRunning && answer.value !== ALL_BROWSERS && running.length > 0 && !running.includes(answer.value)) {
    finish(u, s, { outcome: "rejected", action, detail: `${answer.value} isn't running`, decision: null });
    return true;
  }
  // The original command, with the blank filled in. It still goes through
  // every check — a quit still asks "are you sure?".
  const { slotConfidence: _c, unsureSlot: _s, alternative: _a, ...rest } = held.decision;
  const d: RouteDecision = { ...rest, args: { ...held.decision.args, [held.slot]: answer.value } };
  await serially(() => runClauses(u, s, [held.transcript], [d], held.env, false));
  return true;
}

/** What the agent asks before a destructive action, naming what it would do. */
function confirmQuestion(action: ActionKey, args: Record<string, string | number>, ctx: ActionContext): string {
  const app = typeof args.app === "string" ? args.app : "";
  const apps = app ? listNames(expandApps(app, ctx.runningApps)) : "";
  switch (action) {
    case "quit_app":
      return app === ALL_BROWSERS ? `Quit every open browser — ${apps}?` : `Quit ${apps}?`;
    case "empty_trash":
      return "Empty the Trash? This can't be undone.";
    case "sleep_system":
      return "Put the Mac to sleep?";
    case "click_on":
      return `Click “${String(args.target ?? "")}”?`;
    default:
      return `${phrase(action)}${apps ? ` — ${apps}` : ""}?`;
  }
}

/** Is this utterance essentially the request we are already asking about? */
function repeatsRequest(transcript: string, held: Pending): boolean {
  const said = transcript.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!said) return false;
  const words = new Set(said.split(" ").filter((w) => w.length > 2));
  const original = held.transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (original.length === 0) return false;
  const overlap = original.filter((w) => words.has(w)).length / original.length;
  return overlap >= 0.6;
}

/** Human-readable name for an action key. */
function phrase(action: ActionKey): string {
  return action.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** "photoshop isn't running" → "Photoshop isn't running". */
function sentence(reason: string | undefined): string | undefined {
  if (!reason || reason === "low confidence") return undefined;
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Single exit point: earcon, HUD, activity log, and what happens next. */
function finish(
  u: Utterance,
  s: Session,
  r: Outcome,
  opts: {
    silent?: boolean;
    /**
     * What to do with the conversation afterwards.
     *  open  — keep listening for another command (the normal case)
     *  close — the user dismissed us, or turned listening off
     *  leave — a false trigger: do not open a window, do not close an open one
     */
    conversation?: "open" | "close" | "leave";
    early?: boolean;
  } = {},
): void {
  s.finished = true;
  const { outcome, action, detail, decision } = r;
  const conversation =
    opts.conversation ?? (action === "stop_listening" || action === "cancel" ? "close" : "open");

  if (!opts.silent) play(outcome === "ok" ? "success" : outcome === "cancelled" ? "cancel" : "error");
  const afterSpeech = Date.now() - u.speechEndedAt;
  // Show how quickly it happened: the whole point of acting in real time is
  // that it should feel instant, and a number makes that visible.
  const meta = outcome !== "ok" ? "" : afterSpeech <= 0 ? "early" : `${(afterSpeech / 1000).toFixed(1)} s`;
  coordinator.setState(outcome === "ok" ? "executing" : outcome === "failed" ? "error" : "idle", detail, {
    meta,
    result: outcome,
  });
  fileLog("agent", "finish", { outcome, action, detail, afterSpeechMs: afterSpeech, early: Boolean(opts.early) });

  log({
    transcript: u.transcript,
    action,
    confidence: decision?.confidence ?? null,
    offline: decision?.offline ?? false,
    ...(decision?.instant ? { instant: true } : {}),
    ...(opts.early || s.ran.length ? { early: true } : {}),
    outcome,
    detail,
    timings: {
      transcribe: u.transcribeMs,
      route: decision?.ms ?? 0,
      execute: r.execMs ?? 0,
      afterSpeech,
    },
    ...(decision?.inputTokens ? { inputTokens: decision.inputTokens } : {}),
  });

  if (conversation === "open") openConversation();
  else if (conversation === "close") pipeline?.closeFollowUp("finished");

  const epoch = hudEpoch;
  setTimeout(
    () => {
      // Something newer took over the overlay: a question, or the next command.
      if (epoch !== hudEpoch || coordinator.getState() === "confirming") return;
      coordinator.setTranscript("", false);
      if (pipeline?.inFollowUp) {
        // Stay visible and say so. The user needs to know the microphone is
        // still live without having to guess.
        coordinator.setState("conversing", "Listening — say “that’s it” when you’re done");
        showHud();
        return;
      }
      coordinator.setState("idle");
      hideHud();
    },
    outcome === "ok" ? 1400 : 2600,
  );
}

/** Hold the conversation open so the next command needs no wake word. */
function openConversation(windowMs?: number): void {
  const settings = getSettings();
  if (!settings.followUp || !pipeline) return;
  pipeline.openFollowUp(windowMs ?? settings.followUpSeconds * 1000);
}

function log(partial: Partial<CommandLogEntry> & { transcript: string }): void {
  coordinator.append({
    id: randomUUID(),
    at: Date.now(),
    action: null,
    confidence: null,
    offline: false,
    outcome: "ok",
    detail: "",
    timings: {},
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

/**
 * Toggle-mode only, deliberately.
 *
 * Electron's `globalShortcut` fires on press and has no key-up, so true
 * hold-to-talk is impossible here — it needs a CGEventTap in a native helper
 * (and the Input Monitoring grant that comes with it). Toggle works today,
 * needs no extra permission, and is the fallback that keeps working when the
 * room is too noisy for the wake word.
 */
function registerHotkey(accelerator: string): void {
  unregisterHotkey();
  if (!accelerator) return;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      const p = pipeline;
      if (!p?.listening) return;
      if (coordinator.getState() === "listening") p.stopCapture();
      else p.begin("hotkey");
    });
    registeredHotkey = ok ? accelerator : "";
    if (!ok) fileLog("hotkey", "taken", { accelerator });
  } catch (err) {
    fileLog("hotkey", "invalid", { accelerator, message: describe(err) });
    registeredHotkey = "";
  }
}

function unregisterHotkey(): void {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = "";
}
