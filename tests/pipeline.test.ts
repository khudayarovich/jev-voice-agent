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
  for (const name of ["trigger", "endpoint", "cancelled", "command", "error", "prompt"] as const) {
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

/** Speak, go quiet, and let the endpoint fire. */
async function speakUtterance(h: Harness, blocks = 8): Promise<void> {
  h.setSpeaking(true);
  h.feed(1);
  h.feed(blocks);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
}

// --- tests -----------------------------------------------------------------

test("ignores audio entirely until armed", () => {
  const h = harness();
  h.fireWake();
  h.setSpeaking(true);
  h.feed(5);
  assert.deepEqual(h.events, []);
});

test("speech while armed starts a SILENT capture — nothing is announced yet", () => {
  // We do not know it was meant for us until the transcript says so, and an
  // earcon every time someone in the room speaks would be intolerable.
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(2);
  assert.deepEqual(h.events, [], "no trigger until it is known to be addressed");
});

test("the keyword spotter promotes a capture already in flight", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(1);            // speculative capture begins, silently
  h.fireWake();
  h.feed(1);            // spotter fires -> promoted, user gets the cue
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
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, ["open safari"]);

  // and again
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, ["open safari", "open safari"]);
});

// --- transcript is the wake detector ---------------------------------------

test("a transcript opening with the wake phrase becomes a command", async () => {
  const h = harness({ transcript: "Hey Jeff, open Safari" });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, ["open Safari"], "the wake phrase is stripped off");
});

test("a transcript WITHOUT the wake phrase is discarded silently", async () => {
  const h = harness({ transcript: "so anyway I told him it was fine" });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, []);
  assert.ok(h.events.includes("cancelled"));
  assert.ok(!h.events.includes("trigger"), "nothing should have been announced");
});

test("the bare wake phrase asks the user to go ahead", async () => {
  const h = harness({ transcript: "Hey Jeff" });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.ok(h.events.includes("prompt"));
  assert.deepEqual(h.transcripts, [], "there was no command to run yet");
});

test("the wake phrase is recognised even when the spotter never fires", async () => {
  // This is the whole point of the change: the spotter missing is normal.
  const h = harness({ transcript: "hey jef take a screenshot" });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, ["take a screenshot"]);
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

// --- conversation mode -----------------------------------------------------

test("with a conversation open, speech alone starts a capture", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.setSpeaking(true);
  h.feed(1);
  // No wake word was fired, and none was needed.
  assert.deepEqual(h.events, ["trigger"]);
});

test("without a conversation open, speech alone is ignored", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(3);
  assert.deepEqual(h.events, [], "the wake word is still required outside a conversation");
});

test("a conversation lapses on its own and says so", async () => {
  const h = harness();
  const ended: string[] = [];
  h.pipeline.on("followUpEnded", (r) => ended.push(r));
  h.pipeline.arm();
  h.pipeline.openFollowUp(120);
  assert.equal(h.pipeline.inFollowUp, true);

  await new Promise((r) => setTimeout(r, 200));
  h.setSpeaking(false);
  h.feed(1); // the lapse is noticed on the next frame

  assert.equal(h.pipeline.inFollowUp, false);
  assert.deepEqual(ended, ["timeout"]);
});

test("once lapsed, speech no longer triggers without the wake word", async () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(100);
  await new Promise((r) => setTimeout(r, 180));
  h.setSpeaking(true);
  h.feed(2);
  assert.deepEqual(h.events, [], "the conversation had already closed");
});

test("closing a conversation explicitly takes effect immediately", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.pipeline.closeFollowUp("dismissed");
  h.setSpeaking(true);
  h.feed(2);
  assert.deepEqual(h.events, []);
});

test("a follow-up capture keeps the whole transcript", async () => {
  // Only a wake-triggered capture reaches back over the wake phrase, so only
  // that one should have anything stripped from it.
  const h = harness({ transcript: "hey there open safari" });
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.setSpeaking(true);
  h.feed(1);
  h.feed(8);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
  assert.deepEqual(h.transcripts, ["hey there open safari"]);
});

test("disarming clears any open conversation", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.pipeline.disarm();
  assert.equal(h.pipeline.inFollowUp, false);
});

test("the wake word still works during a conversation", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.setSpeaking(true);
  h.fireWake();
  h.feed(1);
  assert.deepEqual(h.events, ["trigger"]);
});

test("with the wake word off, ambient speech is not captured at all", async () => {
  // Privacy and battery both depend on this: no wake word means no speculative
  // transcription of whatever is said near the microphone.
  const h = harness({
    transcript: "hey jeff open safari",
    settings: { ...DEFAULT_SETTINGS, wakeWordEnabled: false },
  });
  h.pipeline.arm();
  await speakUtterance(h);
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.events, []);
});

test("with the wake word off, the hotkey still works", async () => {
  const h = harness({
    transcript: "open safari",
    settings: { ...DEFAULT_SETTINGS, wakeWordEnabled: false },
  });
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  h.setSpeaking(true);
  h.feed(8);
  h.setSpeaking(false);
  await new Promise((r) => setTimeout(r, 750));
  h.feed(1);
  await settle();
  assert.deepEqual(h.transcripts, ["open safari"]);
});
