import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioPipeline, type PipelineDeps, type WakeLike } from "../src/main/audio/pipeline.ts";
import { RingBuffer } from "../src/main/audio/ring-buffer.ts";
import { DEFAULT_SETTINGS } from "../src/shared/types.ts";
import { SAMPLE_RATE } from "../src/main/audio/wav.ts";

// --- ring buffer -----------------------------------------------------------

test("ring buffer returns the most recent samples, oldest first", () => {
  const r = new RingBuffer(5);
  r.push(Float32Array.from([1, 2, 3]));
  assert.deepEqual([...r.tail(3)], [1, 2, 3]);
  r.push(Float32Array.from([4, 5, 6, 7]));
  // capacity 5, so 1 and 2 have been overwritten
  assert.deepEqual([...r.tail(5)], [3, 4, 5, 6, 7]);
});

test("ring buffer never returns more than it holds", () => {
  const r = new RingBuffer(100);
  r.push(Float32Array.from([1, 2]));
  assert.equal(r.tail(50).length, 2);
  r.clear();
  assert.equal(r.tail(50).length, 0);
});

test("ring buffer survives a push larger than its capacity", () => {
  const r = new RingBuffer(4);
  r.push(Float32Array.from([1, 2, 3, 4, 5, 6]));
  assert.deepEqual([...r.tail(4)], [3, 4, 5, 6]);
});

// --- pipeline harness ------------------------------------------------------

const BLOCK = 1024;

/** A block of "audio". Content is irrelevant — the fake VAD decides speech. */
function block(): Int16Array {
  return new Int16Array(BLOCK);
}

interface Harness {
  pipeline: AudioPipeline;
  setSpeaking(v: boolean): void;
  fireWake(): void;
  setSelfAudio(v: boolean): void;
  transcripts: string[];
  events: string[];
  /** Feed n blocks (each ~64 ms at 16 kHz). */
  feed(n: number): void;
  transcribed: Float32Array[];
}

function harness(overrides: Partial<{ transcript: string; settings: typeof DEFAULT_SETTINGS }> = {}): Harness {
  let speaking = false;
  let selfAudio = false;
  let pendingWake = false;
  const transcribed: Float32Array[] = [];
  const events: string[] = [];
  const transcripts: string[] = [];

  const wake: WakeLike = {
    available: true,
    unsupportedPhrases: [],
    start: () => true,
    accept: () => {
      if (!pendingWake) return null;
      pendingWake = false;
      return { phrase: "hey jeff" };
    },
    reset: () => {},
    suppress: () => {
      pendingWake = false;
    },
    stop: () => {},
  };

  const deps: PipelineDeps = {
    speech: {
      start: async () => {},
      stop: () => {},
      isReady: () => true,
      transcribe: async (samples) => {
        transcribed.push(samples);
        return overrides.transcript ?? "open safari";
      },
    },
    vad: {
      start: () => true,
      accept: () => [],
      get speaking() {
        return speaking;
      },
      reset: () => {},
    },
    makeWake: () => wake,
    isSelfAudioActive: () => selfAudio,
  };

  const pipeline = new AudioPipeline(deps, overrides.settings ?? DEFAULT_SETTINGS);
  for (const name of ["trigger", "endpoint", "cancelled", "command", "error"] as const) {
    pipeline.on(name as "command", (payload: unknown) => {
      events.push(name);
      if (name === "command") transcripts.push((payload as { transcript: string }).transcript);
    });
  }

  return {
    pipeline,
    transcribed,
    events,
    transcripts,
    setSpeaking: (v) => (speaking = v),
    fireWake: () => (pendingWake = true),
    setSelfAudio: (v) => (selfAudio = v),
    feed: (n) => {
      for (let i = 0; i < n; i++) pipeline.acceptFrames(block(), 0.2);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

// --- tests -----------------------------------------------------------------

test("ignores audio entirely until armed", () => {
  const h = harness();
  h.fireWake();
  h.setSpeaking(true);
  h.feed(5);
  assert.deepEqual(h.events, []);
});

test("a wake word with concurrent speech starts a capture", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);
  assert.deepEqual(h.events, ["trigger"]);
});

test("two-factor: a wake word WITHOUT speech is rejected", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(false); // VAD disagrees
  h.fireWake();
  h.feed(1);
  assert.deepEqual(h.events, [], "keyword alone must not trigger");
});

test("earcon playback gates the microphone so the agent cannot hear itself", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSelfAudio(true);
  h.setSpeaking(true);
  h.fireWake();
  h.feed(3);
  assert.deepEqual(h.events, [], "frames during our own audio must be dropped");
});

test("transcribes on trailing silence and reports the transcript", async () => {
  const h = harness({ transcript: "open safari" });
  h.pipeline.arm();
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);           // trigger
  h.feed(8);           // ~0.5 s of speech
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750)); // exceed the endpoint silence
  h.feed(1);
  await settle();
  assert.ok(h.events.includes("endpoint"));
  assert.deepEqual(h.transcripts, ["open safari"]);
});

test("prepends pre-roll so the start of a command is never clipped", async () => {
  const h = harness();
  h.pipeline.arm();
  // Fill the ring with a second of audio BEFORE the user triggers.
  h.feed(16);
  h.setSpeaking(true);
  h.pipeline.begin("hotkey");
  h.feed(4);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
  const audio = h.transcribed[0]!;
  // hotkey pre-roll is 900 ms; without it we would only have the ~0.3 s fed after begin().
  assert.ok(
    audio.length > 0.9 * SAMPLE_RATE,
    `expected pre-roll to be included, got ${(audio.length / SAMPLE_RATE).toFixed(2)}s`,
  );
});

test("a trigger with no speech cancels quietly instead of transcribing", async () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 3100)); // exceed the no-speech timeout
  h.feed(1);
  await settle();
  assert.ok(h.events.includes("cancelled"));
  assert.deepEqual(h.transcripts, []);
});

test("returns to armed after a command, ready for the next one", async () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);
  h.feed(8);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
  // second command works too
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);
  assert.equal(h.events.filter((e) => e === "trigger").length, 2);
});

test("disarm stops everything", () => {
  const h = harness();
  h.pipeline.arm();
  assert.equal(h.pipeline.listening, true);
  h.pipeline.disarm();
  assert.equal(h.pipeline.listening, false);
  h.setSpeaking(true);
  h.fireWake();
  h.feed(2);
  assert.deepEqual(h.events, []);
});

test("an empty transcript cancels rather than reporting a blank command", async () => {
  const h = harness({ transcript: "" });
  h.pipeline.arm();
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);
  h.feed(8);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
  assert.deepEqual(h.transcripts, []);
  assert.ok(h.events.includes("cancelled"));
});
