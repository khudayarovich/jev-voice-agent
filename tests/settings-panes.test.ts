import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_PANES, paneByLabel, shortlistPanes } from "../src/main/actions/settings-panes.ts";

test("finds the settings page a request names", () => {
  assert.deepEqual(shortlistPanes("open bluetooth settings").slice(0, 1), ["Bluetooth"]);
  assert.deepEqual(shortlistPanes("open wi-fi settings").slice(0, 1), ["Wi-Fi"]);
  assert.deepEqual(shortlistPanes("show me the wifi settings").slice(0, 1), ["Wi-Fi"]);
  assert.deepEqual(shortlistPanes("open sound preferences").slice(0, 1), ["Sound"]);
  assert.deepEqual(shortlistPanes("change my wallpaper").slice(0, 1), ["Wallpaper"]);
});

test("the longest matching phrase wins", () => {
  // "screen time" is not the Date & Time page, nor the Displays page.
  assert.equal(shortlistPanes("open screen time settings")[0], "Screen Time");
  assert.equal(shortlistPanes("open lock screen settings")[0], "Lock Screen");
});

test("matches whole words only", () => {
  // "about" must not be found inside "roundabout", nor "mic" inside "microsoft".
  assert.deepEqual(shortlistPanes("roundabout"), []);
  assert.ok(!shortlistPanes("open microsoft word").includes("Sound"));
});

test("names nothing when nothing is named", () => {
  assert.deepEqual(shortlistPanes("open settings"), []);
});

test("every page has a unique label and an identifier", () => {
  const labels = new Set(SETTINGS_PANES.map((p) => p.label));
  assert.equal(labels.size, SETTINGS_PANES.length);
  for (const p of SETTINGS_PANES) {
    assert.ok(p.id.startsWith("com.apple."), p.label);
    assert.equal(paneByLabel(p.label), p);
  }
});
