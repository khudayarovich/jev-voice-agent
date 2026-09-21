import type { AgentState, HudModel } from "../../shared/types.ts";

/**
 * The transcript overlay, and the owner of the app's audio output.
 *
 * Earcons live here because this window is never destroyed and has
 * `backgroundThrottling: false`, so a single AudioContext stays warm for the
 * life of the app. Creating a context per cue would cost 50-150 ms of device
 * setup; decoding per cue would cost more.
 */

const pill = document.getElementById("pill") as HTMLDivElement;
const dot = document.getElementById("dot") as HTMLSpanElement;
const text = document.getElementById("text") as HTMLSpanElement;
const meterFill = document.querySelector("#meter > i") as HTMLElement;

/** States that warrant showing the overlay at all. */
const VISIBLE: ReadonlySet<AgentState> = new Set<AgentState>([
  "conversing",
  "listening",
  "thinking",
  "executing",
  "confirming",
  "error",
]);

let hideTimer: number | undefined;

function render(m: HudModel): void {
  dot.className = `dot ${m.state}`;
  const body = m.transcript || m.detail;
  text.className = `text${m.transcript && m.partial ? " partial" : ""}${!m.transcript ? " detail" : ""}`;
  // Wrapped in a span so the RTL trick that keeps the tail visible doesn't
  // reorder the text itself.
  text.replaceChildren(Object.assign(document.createElement("span"), { textContent: body }));
  meterFill.style.width = `${Math.round(m.level * 100)}%`;

  const show =
    VISIBLE.has(m.state) && Boolean(body || m.state === "listening" || m.state === "conversing");
  window.clearTimeout(hideTimer);
  if (show) {
    pill.classList.remove("hidden");
  } else if (m.state === "error") {
    // Let an error linger long enough to read.
    hideTimer = window.setTimeout(() => pill.classList.add("hidden"), 2600);
  } else {
    pill.classList.add("hidden");
  }
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
