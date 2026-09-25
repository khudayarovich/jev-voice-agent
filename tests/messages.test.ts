import assert from "node:assert/strict";
import { test } from "node:test";
import { messageRequest } from "../src/main/actions/messages.ts";
import { splitCommands } from "../src/main/actions/split.ts";

const APPS = ["Codex", "ChatGPT", "Telegram", "Safari", "Terminal"];

test("a message names its app and carries its text whole", () => {
  assert.deepEqual(messageRequest("send a prompt to Codex saying fix the failing tests and run them", APPS), { app: "Codex", text: "fix the failing tests and run them" });
  assert.deepEqual(messageRequest("ask ChatGPT what is the capital of Peru", APPS), { app: "ChatGPT", text: "what is the capital of Peru" });
  assert.deepEqual(messageRequest("tell codex to run the build", APPS), { app: "Codex", text: "run the build" });
  assert.deepEqual(messageRequest("send hello there to Telegram", APPS), { app: "Telegram", text: "hello there" });
});

test("with no app named, the one in front is meant", () => {
  assert.deepEqual(messageRequest("send a prompt saying write a haiku about rain", APPS), { app: null, text: "write a haiku about rain" });
  assert.deepEqual(messageRequest("and send a message: hello", APPS), { app: null, text: "hello" });
  assert.deepEqual(messageRequest("send", APPS), { app: null, text: null });
});

test("'open Codex and send a prompt …' is two commands, the prompt kept whole", () => {
  const parts = splitCommands("open Codex and send a prompt saying refactor the parser and add tests");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "open Codex");
  assert.match(parts[1]!, /^send a prompt saying refactor the parser and add tests$/);
});
