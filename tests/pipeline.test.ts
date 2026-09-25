import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioPipeline, type PipelineDeps, type Utterance, type WakeLike } from "../src/main/audio/pipeline.ts";
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

/** 1024 samples: 64 ms at 16 kHz, the size the capture renderer sends. */
const BLOCK = 1024;
const BLOCK_MS = (BLOCK / SAMPLE_RATE) * 1000;

interface Options {
  /** What the recogniser "hears": fixed text, or chosen per call. */
  transcript?: string | ((call: number, seconds: number) => string);
  settings?: typeof DEFAULT_SETTINGS;
  /** Engine speed. Slow (the default here) means no transcription mid-speech. */
  engineMs?: number;
}

interface Harness {
  pipeline: AudioPipeline;
  events: string[];
  utterances: Utterance[];
  partials: string[];
  /** Audio handed to the recogniser, per call. */
  transcribed: Float32Array[];
  setSpeaking(v: boolean): void;
  fireWake(): void;
  setSelfAudio(v: boolean): void;
  /** Feed n blocks with the VAD saying whatever it currently says. */
  feed(n: number): void;
  /** Speak for n blocks. */
  speak(n: number): Promise<void>;
  /** Be quiet for about `ms`. */
  quiet(ms: number): Promise<void>;
}

/** Let transcription promises resolve. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function harness(opts: Options = {}): Harness {
  let speaking = false;
  let selfAudio = false;
  let pendingWake = false;
  let calls = 0;
  const transcribed: Float32Array[] = [];
  const events: string[] = [];
  const utterances: Utterance[] = [];
  const partials: string[] = [];

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
      typicalMs: opts.engineMs ?? 600,
      transcribe: async (samples) => {
        transcribed.push(samples);
        const t = opts.transcript ?? "open safari";
        return typeof t === "function" ? t(calls++, samples.length / SAMPLE_RATE) : t;
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

  const pipeline = new AudioPipeline(deps, opts.settings ?? DEFAULT_SETTINGS);
  for (const name of ["capture", "trigger", "pause", "endpoint", "cancelled", "error", "prompt"] as const) {
    pipeline.on(name as "endpoint", () => events.push(name));
  }
  pipeline.on("utterance", (u) => {
    events.push(u.final ? "utterance:final" : "utterance:tentative");
    utterances.push(u);
  });
  pipeline.on("partial", (p) => {
    events.push("partial");
    partials.push(p.transcript);
  });

  const feed = (n: number) => {
    for (let i = 0; i < n; i++) pipeline.acceptFrames(new Int16Array(BLOCK), 0.2);
  };

  return {
    pipeline,
    events,
    utterances,
    partials,
    transcribed,
    setSpeaking: (v) => (speaking = v),
    fireWake: () => (pendingWake = true),
    setSelfAudio: (v) => (selfAudio = v),
    feed,
    speak: async (n) => {
      speaking = true;
      for (let i = 0; i < n; i++) {
        feed(1);
        await settle();
      }
    },
    quiet: async (ms) => {
      speaking = false;
      for (let i = 0; i < Math.ceil(ms / BLOCK_MS); i++) {
        feed(1);
        await settle();
      }
    },
  };
}

/** Say something and go quiet long enough for it to be final. */
async function utter(h: Harness, blocks = 12): Promise<void> {
  await h.speak(blocks);
  await h.quiet(1500);
}

const finals = (h: Harness) => h.utterances.filter((u) => u.final).map((u) => u.transcript);
const said = (h: Harness) => h.utterances.map((u) => u.transcript);

// --- basics ----------------------------------------------------------------

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
  assert.deepEqual(h.events, ["capture"], "no trigger until it is known to be addressed");
});

test("the keyword spotter promotes a capture already in flight", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(1); // speculative capture begins, silently
  h.fireWake();
  h.feed(1); // spotter fires -> promoted, the overlay lights up
  assert.deepEqual(h.events, ["capture", "trigger"]);
});

test("the hotkey promotes a capture already in flight", () => {
  // Pressing the key a beat after starting to talk used to do nothing at all,
  // because a silent speculative capture was already running.
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(2);
  h.pipeline.begin("hotkey");
  assert.deepEqual(h.events, ["capture", "trigger"]);
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
  assert.deepEqual(h.events, [], "our own audio must not start anything");
});

test("a cue playing DURING a command does not cut audio out of it", async () => {
  // Dropping frames while a cue played used to remove ~300 ms from the middle
  // of whatever the user was saying.
  const h = harness({ transcript: "open safari" });
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  await h.speak(5);
  h.setSelfAudio(true);
  await h.speak(5);
  h.setSelfAudio(false);
  await h.speak(5);
  await h.quiet(1500);
  const audio = h.transcribed.at(-1)!;
  const expected = (15 * BLOCK) / SAMPLE_RATE;
  assert.ok(
    audio.length / SAMPLE_RATE >= expected,
    `every spoken block should be kept, got ${(audio.length / SAMPLE_RATE).toFixed(2)}s`,
  );
});

// --- acting at the pause ---------------------------------------------------

test("hands over a TENTATIVE utterance at the pause, before the silence runs out", async () => {
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(BLOCK_MS); // one block of quiet: the pause
  assert.deepEqual(said(h), ["open safari"], "transcribed and handed over at the pause");
  assert.equal(h.utterances[0]!.final, false, "the user may still go on");
  assert.ok(!h.events.includes("endpoint"), "the silence has not run out yet");

  await h.quiet(1000);
  assert.equal(await h.utterances[0]!.settled, "final", "and after the silence it is final");
  assert.equal(h.utterances.length, 1, "the same utterance — not a second copy");
});

test("committing at the pause ends the capture there", async () => {
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(BLOCK_MS);
  const u = h.utterances[0]!;
  assert.equal(u.commit(), true);
  assert.equal(await u.settled, "final");
  await h.quiet(1500);
  assert.equal(h.utterances.length, 1);
  assert.ok(!h.events.includes("endpoint"), "nothing left to end");
});

test("speaking again after the pause withdraws the tentative utterance", async () => {
  let heard = "hey jeff open safari";
  const h = harness({ transcript: () => heard });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(BLOCK_MS);
  const first = h.utterances[0]!;
  assert.equal(first.final, false);

  heard = "hey jeff open safari and go to github";
  await h.speak(10);
  assert.equal(await first.settled, "resumed");
  assert.equal(first.commit(), false, "too late to act on the first half alone");

  await h.quiet(1500);
  assert.deepEqual(said(h), ["open safari", "open safari and go to github"]);
  assert.equal(await h.utterances[1]!.settled, "final");
});

test("an unfinished-sounding pause waits longer before giving up on the rest", async () => {
  const h = harness({ transcript: "hey jeff set the volume to" });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(800);
  assert.ok(!h.events.includes("endpoint"), "'set the volume to' is not a finished thought");
  await h.quiet(800);
  assert.ok(h.events.includes("endpoint"), "but it does end eventually");
});

test("a complete-sounding pause ends quickly", async () => {
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(700);
  assert.ok(h.events.includes("endpoint"), "well under the old 1.4 s of dead air");
});

test("prepends pre-roll so the start of a command is never clipped", async () => {
  const h = harness();
  h.pipeline.arm();
  // Fill the ring with a second of audio BEFORE the user triggers.
  h.feed(16);
  h.pipeline.begin("hotkey");
  await h.speak(4);
  await h.quiet(1500);
  const audio = h.transcribed[0]!;
  // hotkey pre-roll is 900 ms; without it we would only have the ~0.3 s fed after begin().
  assert.ok(
    audio.length > 0.9 * SAMPLE_RATE,
    `expected pre-roll to be included, got ${(audio.length / SAMPLE_RATE).toFixed(2)}s`,
  );
});

test("pre-roll never reaches back into the previous command", async () => {
  const h = harness({ transcript: "open safari" });
  h.pipeline.arm();
  h.pipeline.openFollowUp(60_000);
  await h.speak(12);
  await h.quiet(BLOCK_MS);
  assert.equal(h.utterances[0]!.commit(), true);
  // Straight back to talking: the follow-up capture must start after the
  // committed audio, not 700 ms before it.
  await h.speak(4);
  await h.quiet(1500);
  const second = h.transcribed.at(-1)!;
  assert.ok(
    second.length / SAMPLE_RATE < 0.3 + (4 * BLOCK + 1500 * 16) / SAMPLE_RATE,
    `pre-roll crossed into the previous command: ${(second.length / SAMPLE_RATE).toFixed(2)}s`,
  );
});

test("a trigger with no speech cancels quietly instead of transcribing", async () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  await h.quiet(3200);
  assert.ok(h.events.includes("cancelled"));
  assert.deepEqual(h.transcribed, []);
});

test("returns to armed after a command, ready for the next one", async () => {
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await utter(h);
  await utter(h);
  assert.deepEqual(finals(h), [], "tentative utterances settle final rather than being re-sent");
  assert.deepEqual(said(h), ["open safari", "open safari"]);
  assert.equal(await h.utterances[1]!.settled, "final");
});

// --- the transcript is the wake detector ------------------------------------

test("a transcript opening with the wake phrase becomes a command", async () => {
  const h = harness({ transcript: "Hey Jeff, open Safari" });
  h.pipeline.arm();
  await utter(h);
  assert.deepEqual(said(h), ["open Safari"], "the wake phrase is stripped off");
  assert.ok(h.events.includes("trigger"), "and the overlay was told");
});

test("a transcript WITHOUT the wake phrase is discarded silently", async () => {
  const h = harness({ transcript: "so anyway I told him it was fine" });
  h.pipeline.arm();
  await utter(h);
  assert.deepEqual(said(h), []);
  assert.ok(h.events.includes("cancelled"));
  assert.ok(!h.events.includes("trigger"), "nothing should have been announced");
  assert.ok(!h.events.includes("endpoint"), "and no end-of-command cue for someone else's sentence");
});

test("the bare wake phrase says 'go ahead' at the pause, once", async () => {
  const h = harness({ transcript: "Hey Jeff" });
  h.pipeline.arm();
  await h.speak(8);
  await h.quiet(BLOCK_MS * 2);
  assert.deepEqual(h.events.filter((e) => e === "prompt"), ["prompt"], "acknowledged at the pause");
  await h.quiet(2000);
  assert.deepEqual(h.events.filter((e) => e === "prompt"), ["prompt"], "and not a second time");
  assert.deepEqual(said(h), [], "there was no command to run yet");
});

test("the wake phrase is recognised even when the spotter never fires", async () => {
  const h = harness({ transcript: "hey jef take a screenshot" });
  h.pipeline.arm();
  await utter(h);
  assert.deepEqual(said(h), ["take a screenshot"]);
});

test("disarm stops everything and withdraws what was pending", async () => {
  const h = harness({ transcript: "hey jeff open safari" });
  h.pipeline.arm();
  await h.speak(12);
  await h.quiet(BLOCK_MS);
  const u = h.utterances[0]!;
  h.pipeline.disarm();
  assert.equal(await u.settled, "dropped");
  assert.equal(h.pipeline.listening, false);
  h.setSpeaking(true);
  h.fireWake();
  h.feed(2);
  assert.equal(h.utterances.length, 1);
});

test("an empty transcript cancels rather than reporting a blank command", async () => {
  const h = harness({ transcript: "" });
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  await utter(h);
  assert.deepEqual(said(h), []);
  assert.ok(h.events.includes("cancelled"));
});

// --- streaming -------------------------------------------------------------

test("with a fast engine, live text arrives while the user is still speaking", async () => {
  const h = harness({ transcript: "hey jeff open notes and create a", engineMs: 150 });
  h.pipeline.arm();
  await h.speak(24);
  assert.ok(h.partials.length >= 1, "a partial while speaking");
  assert.equal(h.partials[0], "open notes and create a");
  assert.ok(h.events.indexOf("trigger") < h.events.indexOf("partial"), "overlay lit mid-sentence");
  assert.deepEqual(said(h), [], "nothing is final while they are still talking");
});

test("with a slow engine, nothing is transcribed mid-speech", async () => {
  // At ~600 ms a pass, transcribing mid-speech would hold the engine exactly
  // when the pause's transcription needs it.
  const h = harness({ transcript: "hey jeff open notes", engineMs: 600 });
  h.pipeline.arm();
  await h.speak(40);
  assert.deepEqual(h.transcribed, []);
});

test("someone else's conversation is dropped early, and not re-captured mid-sentence", async () => {
  const h = harness({ transcript: "so I was telling him about the meeting", engineMs: 150 });
  h.pipeline.arm();
  await h.speak(40);
  assert.ok(h.events.includes("cancelled"), "rejected from the first partial");
  const captures = h.events.filter((e) => e === "capture").length;
  assert.equal(captures, 1, "and the rest of their sentence is not captured again");
  const passes = h.transcribed.length;
  await h.speak(20);
  assert.equal(h.transcribed.length, passes, "no more transcription of it");
});

test("streaming is off when realtime is switched off", async () => {
  const h = harness({
    transcript: "hey jeff open notes",
    engineMs: 100,
    settings: { ...DEFAULT_SETTINGS, realtime: false },
  });
  h.pipeline.arm();
  await h.speak(30);
  assert.deepEqual(h.partials, []);
});

// --- conversation mode -----------------------------------------------------

test("with a conversation open, speech alone starts a capture", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.setSpeaking(true);
  h.feed(1);
  // No wake word was fired, and none was needed.
  assert.deepEqual(h.events, ["capture", "trigger"]);
});

test("without a conversation open, speech alone is not announced", () => {
  const h = harness();
  h.pipeline.arm();
  h.setSpeaking(true);
  h.feed(3);
  assert.ok(!h.events.includes("trigger"), "the wake word is still required outside a conversation");
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

test("a conversation does not lapse while its command is being acted on", async () => {
  // Observed in real use: the window ran out between the end of the command
  // and its result, and the overlay vanished mid-command.
  const h = harness({ transcript: "open safari" });
  const ended: string[] = [];
  h.pipeline.on("followUpEnded", (r) => ended.push(r));
  h.pipeline.arm();
  h.pipeline.openFollowUp(300);
  await h.speak(4);
  await h.quiet(BLOCK_MS);
  await new Promise((r) => setTimeout(r, 400));
  await h.quiet(300);
  assert.deepEqual(ended, []);
});

test("once lapsed, speech no longer triggers without the wake word", async () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(100);
  await new Promise((r) => setTimeout(r, 180));
  h.setSpeaking(true);
  h.feed(2);
  assert.ok(!h.events.includes("trigger"), "the conversation had already closed");
});

test("closing a conversation explicitly takes effect immediately", () => {
  const h = harness();
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  h.pipeline.closeFollowUp("dismissed");
  h.setSpeaking(true);
  h.feed(2);
  assert.ok(!h.events.includes("trigger"));
});

test("a follow-up capture keeps the whole transcript", async () => {
  // Only a wake-triggered capture reaches back over the wake phrase, so only
  // that one should have anything stripped from it.
  const h = harness({ transcript: "hey there open safari" });
  h.pipeline.arm();
  h.pipeline.openFollowUp(10_000);
  await utter(h);
  assert.deepEqual(said(h), ["hey there open safari"]);
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
  assert.deepEqual(h.events, ["capture", "trigger"]);
});

test("with the wake word off, ambient speech is not captured at all", async () => {
  // Privacy and battery both depend on this: no wake word means no speculative
  // transcription of whatever is said near the microphone.
  const h = harness({
    transcript: "hey jeff open safari",
    settings: { ...DEFAULT_SETTINGS, wakeWordEnabled: false },
  });
  h.pipeline.arm();
  await utter(h);
  assert.deepEqual(said(h), []);
  assert.deepEqual(h.events, []);
});

test("with the wake word off, the hotkey still works", async () => {
  const h = harness({
    transcript: "open safari",
    settings: { ...DEFAULT_SETTINGS, wakeWordEnabled: false },
  });
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  await utter(h, 8);
  assert.deepEqual(said(h), ["open safari"]);
});

test("the hotkey pressed again ends the capture at once", async () => {
  const h = harness({ transcript: "open safari" });
  h.pipeline.arm();
  h.pipeline.begin("hotkey");
  await h.speak(8);
  h.pipeline.stopCapture();
  await h.quiet(BLOCK_MS);
  assert.ok(h.events.includes("endpoint"));
  assert.deepEqual(finals(h), ["open safari"]);
});
