import assert from "node:assert/strict";
import { test } from "node:test";
import { asStr, runAppleScript } from "../src/main/platform/macos/osascript.ts";

test("runs a script and returns stdout", async () => {
  const r = await runAppleScript(`return "hello"`);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "hello");
  assert.equal(r.timedOut, false);
});

test("reads system state without triggering an Automation prompt", async () => {
  // `get volume settings` is a scripting addition on the current process, not an
  // Apple Event to another app, so it needs no Automation grant.
  const r = await runAppleScript(`return output volume of (get volume settings)`);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /^\d+$/);
});

test("the OUTER process kill fires when the inner timeout cannot help", async () => {
  // `delay` is not an Apple Event send, so AppleScript's `with timeout` does not
  // bound it. This is precisely the case the hard execFile kill exists for: on
  // macOS 26 a wedged script would otherwise hang for two minutes.
  const started = Date.now();
  const r = await runAppleScript(`delay 30`, { timeoutMs: 1200 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, "should report a timeout");
  assert.ok(elapsed < 4000, `killed promptly, took ${elapsed}ms`);
});

test("parses the AppleScript error number off stderr", async () => {
  const r = await runAppleScript(`error "boom" number -1743`);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, -1743);
});

test("wraps scripts in an inner timeout guard by default", async () => {
  const r = await runAppleScript(`return 1`, { timeoutMs: 5000 });
  assert.equal(r.ok, true);
  // 80% of 5000ms, floored to whole seconds.
  const r2 = await runAppleScript(`return 2`, { timeoutMs: 5000, noWrap: true });
  assert.equal(r2.ok, true);
});

test("asStr escapes quotes and backslashes", () => {
  assert.equal(asStr(`say "hi"`), `"say \\"hi\\""`);
  assert.equal(asStr(`a\\b`), `"a\\\\b"`);
});

test("escaped strings survive a round trip through osascript", async () => {
  const tricky = `quote " and backslash \\ end`;
  const r = await runAppleScript(`return ${asStr(tricky)}`);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, tricky);
});
