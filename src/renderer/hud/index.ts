import { hudBody } from "../../shared/hud.ts";
import type { AgentState, HudModel } from "../../shared/types.ts";

/**
 * The transcript overlay, and the owner of the app's audio output.
 *
 * Earcons live here because this window is never destroyed and has
 * `backgroundThrottling: false`, so a single AudioContext stays warm for the
 * life of the app. Creating a context per cue would cost 50-150 ms of device
 * setup; decoding per cue would cost more.
 *
 * Rendering is incremental: the model arrives ~15 times a second while the mic
 * is live (the level meter), so only what actually changed is touched, and the
 * visualizer runs on its own animation frame, smoothing toward the latest level.
 */

const pill = document.getElementById("pill") as HTMLDivElement;
const text = document.getElementById("text") as HTMLDivElement;
const words = document.getElementById("words") as HTMLSpanElement;
const badge = document.getElementById("badge") as HTMLSpanElement;
const bars = [...document.querySelectorAll<HTMLElement>("#viz > i")];

/** States that warrant showing the overlay at all. */
const VISIBLE: ReadonlySet<AgentState> = new Set<AgentState>([
  "conversing",
  "listening",
  "thinking",
  "executing",
  "confirming",
  "error",
]);

/** Where the pill's width may go: never a sliver, never wider than the window. */
const MIN_WIDTH = 190;
const MAX_WIDTH = 540;

let shownText = "";
let lastResult: string | undefined;
let hideTimer: number | undefined;
let visible = false;

function render(m: HudModel): void {
  const stateChanged = pill.dataset.state !== m.state;
  pill.dataset.state = m.state;

  const result = m.result;
  if (result) pill.dataset.result = result;
  else delete pill.dataset.result;
  if (result && result !== lastResult) celebrate(result);
  lastResult = result;

  const body = hudBody(m);
  const theirs = Boolean(m.transcript) && body === m.transcript;
  text.classList.toggle("partial", theirs && m.partial);
  text.classList.toggle("detail", !theirs);
  const textChanged = setText(body);

  const meta = result === "ok" ? (m.meta ?? "") : "";
  if (badge.textContent !== meta) badge.textContent = meta;

  target = m.level;

  const show = VISIBLE.has(m.state) && Boolean(body || m.state === "listening" || m.state === "conversing");
  window.clearTimeout(hideTimer);
  if (show) {
    setVisible(true);
  } else if (m.state === "error" || result === "failed" || result === "rejected") {
    // Let a problem linger long enough to read.
    hideTimer = window.setTimeout(() => setVisible(false), 2600);
  } else {
    setVisible(false);
  }

  if (textChanged || stateChanged) fit(!theirs);
  driveVisualizer();
}

function setVisible(on: boolean): void {
  if (on === visible) return;
  visible = on;
  pill.classList.toggle("hidden", !on);
}

/**
 * Update the words, animating only what is new.
 *
 * A growing transcript ("open" → "open Saf" → "open Safari") appends its new
 * tail, which fades in; anything else replaces the line with a quick swap. The
 * text is always set through textContent — it is speech, never markup.
 */
function setText(next: string): boolean {
  if (next === shownText) return false;
  if (shownText && next.startsWith(shownText)) {
    const tail = document.createElement("span");
    tail.className = "w-new";
    tail.textContent = next.slice(shownText.length);
    words.append(tail);
    // Fold finished animations back into plain text so the DOM stays small.
    if (words.childNodes.length > 12) words.textContent = next;
  } else {
    words.textContent = next;
    words.classList.remove("swap");
    void words.offsetWidth; // restart the animation
    words.classList.add("swap");
  }
  shownText = next;
  return true;
}

/**
 * Glide the pill to fit its text. The window cannot resize smoothly, so the
 * pill does it inside the window; CSS animates the change.
 */
function fit(wraps: boolean): void {
  text.classList.remove("wrap"); // measured as one line
  const natural = words.scrollWidth;
  // padding-left, orb, gap, gap before the visualizer, padding-right — the
  // visualizer is always a flex item, so its gap counts even when it is empty.
  const chrome = 8 + 28 + 10 + 10 + 16;
  const state = pill.dataset.state;
  const viz = state === "listening" || state === "conversing" || state === "thinking" ? 25 : 0;
  const tag = badge.textContent ? badge.offsetWidth + 10 : 0;
  const wanted = chrome + viz + tag + natural + 2;
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, wanted));
  pill.style.setProperty("--w", `${Math.round(width)}px`);
  // Decided from the target width, not measured: mid-animation the pill is
  // still narrow, and measuring then faded out text that was about to fit.
  const overflow = wanted > MAX_WIDTH;
  // The agent's own line wraps onto a second, so a question or a list can be
  // read whole; a transcript keeps its newest words in view instead.
  text.classList.toggle("wrap", overflow && wraps);
  text.classList.toggle("clip", overflow && !wraps);
}

/** The pop of success, the shake of failure. */
function celebrate(result: string): void {
  const cls = result === "ok" ? "pop" : result === "failed" || result === "rejected" ? "shake" : "";
  if (!cls) return;
  pill.classList.remove("pop", "shake");
  void pill.offsetWidth;
  pill.classList.add(cls);
}
pill.addEventListener("animationend", (e) => {
  if (e.target === pill) pill.classList.remove("pop", "shake");
});

// ---------------------------------------------------------------------------
// Voice visualizer
// ---------------------------------------------------------------------------

let target = 0;
let smooth = 0;
let raf = 0;

/**
 * Bars and orb follow the microphone while it is live, smoothed so they move
 * like a voice rather than like a meter. Stops when nothing is listening.
 */
function driveVisualizer(): void {
  const live = visible && (pill.dataset.state === "listening" || pill.dataset.state === "conversing");
  if (live && !raf) raf = requestAnimationFrame(frame);
  if (!live && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    pill.style.setProperty("--lvl", "0");
    for (const b of bars) b.style.transform = "";
  }
}

function frame(t: number): void {
  // Rise quickly, fall slowly: speech is spiky, and a meter that drops the
  // instant a syllable ends looks broken.
  smooth += (target - smooth) * (target > smooth ? 0.45 : 0.12);
  // RMS of ordinary speech is ~0.02-0.1; a square-root curve spreads that
  // across the whole range.
  const v = Math.min(1, Math.sqrt(smooth) * 2.4);
  pill.style.setProperty("--lvl", v.toFixed(3));
  bars.forEach((b, i) => {
    const sway = 0.55 + 0.45 * Math.sin(t / 150 + i * 1.7);
    b.style.transform = `scaleY(${(0.18 + v * sway * 0.82).toFixed(3)})`;
  });
  raf = requestAnimationFrame(frame);
}

window.jev.on.hud(render);

// ---------------------------------------------------------------------------
// Earcons
// ---------------------------------------------------------------------------

const CUES = ["wake", "endpoint", "success", "error", "confirm", "cancel"] as const;
type Cue = (typeof CUES)[number];

const buffers = new Map<Cue, AudioBuffer>();
let ctx: AudioContext | null = null;

async function initAudio(): Promise<void> {
  // `latencyHint: "interactive"` asks CoreAudio for the smallest safe buffer.
  ctx = new AudioContext({ latencyHint: "interactive" });
  const raw = await window.jev.audio.cues();
  await Promise.all(
    CUES.map(async (name) => {
      const bytes = raw[name];
      if (!bytes) return;
      try {
        // decodeAudioData detaches its input, so hand it a private copy.
        const copy = new Uint8Array(bytes).buffer;
        buffers.set(name, await ctx!.decodeAudioData(copy));
      } catch {
        // A malformed cue degrades to silence, never to a broken HUD.
      }
    }),
  );
}

function playCue(name: string, volume: number): void {
  const buf = buffers.get(name as Cue);
  if (!ctx || !buf) return;
  // Autoplay policy can leave the context suspended until something resumes it.
  if (ctx.state === "suspended") void ctx.resume();
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume));
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start();
}

window.jev.on.earcon(playCue);
void initAudio();
