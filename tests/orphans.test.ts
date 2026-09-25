import assert from "node:assert/strict";
import { test } from "node:test";
import { orphanedServers } from "../src/main/audio/orphans.ts";

/**
 * Which speech servers may be killed on start. From real use: a benchmark
 * started beside the running app killed the app's live server, and every
 * command after that failed with "speech engine not started".
 */

const MODELS = "/Users/me/Library/Application Support/jev-voice-agent/models";
const BIN = "/Applications/Jev Voice Agent.app/Contents/Resources/whisper/whisper-server";

const listing = [
  `  101     1 ${BIN} -m ${MODELS}/ggml-small.en.bin --host 127.0.0.1 --port 50001`,
  `  202   150 ${BIN} -m ${MODELS}/ggml-large-v3-turbo-q5_0.bin --host 127.0.0.1 --port 50002`,
  `  303     1 /opt/other/whisper-server -m /elsewhere/model.bin --port 9000`,
  `  404     1 /usr/bin/some-other-tool -m ${MODELS}/ggml-small.en.bin`,
  `  505     1 ${BIN}-helper -m ${MODELS}/x.bin`,
].join("\n");

test("reaps a server whose app died, and nothing else", () => {
  assert.deepEqual(orphanedServers(listing, MODELS), [101]);
});

test("never touches a server that still has a live parent", () => {
  // PID 202 belongs to a running copy of the app: it is working, not left over.
  assert.ok(!orphanedServers(listing, MODELS).includes(202));
});

test("leaves other programs' servers alone", () => {
  const pids = orphanedServers(listing, MODELS);
  assert.ok(!pids.includes(303), "another app's whisper-server");
  assert.ok(!pids.includes(404), "not a whisper server at all");
  assert.ok(!pids.includes(505), "a different binary that merely starts with the name");
});

test("copes with nothing to read", () => {
  assert.deepEqual(orphanedServers("", MODELS), []);
});
