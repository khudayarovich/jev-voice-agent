/**
 * Generates the indicator sounds.
 *
 * Design constraints, all deliberate:
 *  - **Short** (60-160 ms). These fire constantly; anything longer is grating,
 *    and the mic is gated for the duration plus a reverb tail, so long cues
 *    mean long deaf spots.
 *  - **Pure sines with raised-cosine envelopes.** A hard start/stop is a click,
 *    and a click is broadband — precisely the signal most likely to trip the
 *    VAD or the keyword spotter. Narrowband tones are much easier to ignore.
 *  - **Distinguishable without being musical.** Rising = opening, falling =
 *    closing, so the meaning is guessable without training.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/earcons");
const RATE = 48000;

/** Raised-cosine attack/release: kills the click without smearing the tone. */
function envelope(i, total, rampMs) {
  const ramp = Math.max(1, Math.floor((rampMs / 1000) * RATE));
  if (i < ramp) return 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
  if (i > total - ramp) return 0.5 - 0.5 * Math.cos((Math.PI * (total - i)) / ramp);
  return 1;
}

/** One frequency sweep (or steady tone when f0 === f1). */
function tone({ f0, f1 = f0, ms, gain = 0.28, ramp = 8, curve = "lin" }) {
  const n = Math.floor((ms / 1000) * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = curve === "exp" ? f0 * Math.pow(f1 / f0, t) : f0 + (f1 - f0) * t;
    phase += (2 * Math.PI * f) / RATE;
    out[i] = Math.sin(phase) * envelope(i, n, ramp) * gain;
  }
  return out;
}

function silence(ms) {
  return new Float32Array(Math.floor((ms / 1000) * RATE));
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Mono 16-bit PCM WAV. Decoded once at startup into an AudioBuffer. */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const CUES = {
  /** Wake word heard — now listening. Rising, "I'm open". */
  wake: () => tone({ f0: 800, f1: 1200, ms: 90, curve: "exp" }),
  /** Capture ended, thinking. Falling, "I'm closed". */
  endpoint: () => tone({ f0: 1200, f1: 800, ms: 80, curve: "exp", gain: 0.22 }),
  /** Action succeeded. Two rising notes. */
  success: () => concat([
    tone({ f0: 900, ms: 55, gain: 0.24 }),
    silence(18),
    tone({ f0: 1350, ms: 70, gain: 0.24 }),
  ]),
  /** Action failed, or nothing matched. Low and flat. */
  error: () => concat([
    tone({ f0: 340, ms: 80, gain: 0.26 }),
    silence(20),
    tone({ f0: 280, ms: 130, gain: 0.26 }),
  ]),
  /** Destructive action — waiting for a spoken yes. Insistent double blip. */
  confirm: () => concat([
    tone({ f0: 1100, ms: 55, gain: 0.26 }),
    silence(60),
    tone({ f0: 1100, ms: 55, gain: 0.26 }),
  ]),
  /** Dismissed / cancelled. Single soft drop. */
  cancel: () => tone({ f0: 700, f1: 480, ms: 100, curve: "exp", gain: 0.2 }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(CUES)) {
  writeFileSync(path.join(OUT, `${name}.wav`), wav(make()));
}
console.log(`[earcons] wrote ${Object.keys(CUES).length} cues to resources/earcons`);
