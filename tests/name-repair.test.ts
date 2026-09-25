import assert from "node:assert/strict";
import { test } from "node:test";
import { repairAppNames, skeleton } from "../src/main/audio/name-repair.ts";

// The apps actually on the machine this was built against.
const APPS = [
  "Claude", "Cursor", "Safari", "Firefox", "Google Chrome", "Terminal", "Telegram",
  "Bitwarden", "Termius", "PhpStorm", "PyCharm", "Godot", "Moonlight", "Xcode",
  "Clock", "Calculator", "Notes", "GitHub Desktop", "Parallels Desktop",
];
const fix = (t: string) => repairAppNames(t, APPS).text;

test("vowels are what recognisers get wrong, so the skeleton ignores them", () => {
  const target = skeleton("claude");
  for (const heard of ["clawed", "clod", "cloud", "cloudy"]) {
    assert.equal(skeleton(heard), target, heard);
  }
});

test("repairs the exact failures seen in real use", () => {
  // Every one of these came back from a real recogniser.
  assert.equal(fix("open clawed"), "open Claude");
  assert.equal(fix("open cloudy."), "open Claude.");
  assert.equal(fix("switch to clod"), "switch to Claude");
  assert.equal(fix("open termias."), "open Termius.");
});

test("leaves a correct transcript completely alone", () => {
  for (const t of [
    "open Claude",
    "open Safari",
    "take a screenshot",
    "set volume to thirty percent",
    "close this window",
  ]) {
    assert.equal(fix(t), t, t);
  }
});

test("never rewrites the command verbs themselves", () => {
  // Without a protected list, "close" becomes "Clock" and the command is eaten.
  assert.equal(fix("close the window"), "close the window");
  assert.equal(fix("search for cats"), "search for cats");
  assert.equal(fix("go back"), "go back");
  assert.equal(fix("turn on dark mode"), "turn on dark mode");
});

test("does not invent an app from an unrelated word", () => {
  assert.equal(fix("open the pod bay doors"), "open the pod bay doors");
  assert.equal(fix("what is the weather"), "what is the weather");
});

test("keeps the punctuation the recogniser added", () => {
  assert.equal(fix("open clawed."), "open Claude.");
  assert.equal(fix("open termias?"), "open Termius?");
});

test("repairs more than one name in a chained request", () => {
  const r = repairAppNames("open clawed and open termias", APPS);
  assert.equal(r.text, "open Claude and open Termius");
  assert.deepEqual(r.repairs, [
    { from: "clawed", to: "Claude" },
    { from: "termias", to: "Termius" },
  ]);
});

test("is safe with no apps or empty input", () => {
  assert.equal(repairAppNames("open clawed", []).text, "open clawed");
  assert.equal(repairAppNames("", APPS).text, "");
  assert.equal(repairAppNames("   ", APPS).text, "   ");
});

test("does not confuse two genuinely different apps", () => {
  // PyCharm and PhpStorm are both JetBrains editors but nothing alike in shape.
  assert.equal(fix("open PyCharm"), "open PyCharm");
  assert.equal(fix("open PhpStorm"), "open PhpStorm");
});

test("reports what it changed, so the log can show it", () => {
  const r = repairAppNames("open cloudy", APPS);
  assert.deepEqual(r.repairs, [{ from: "cloudy", to: "Claude" }]);
});

test("an ordinary noun is not turned into the app named after its plural", () => {
  // Observed: "open Notes and create a new note" came out as "... a new Notes",
  // which routed the second half to opening Notes a second time.
  const apps = [...APPS, "Notes", "Photos", "Messages", "Reminders"];
  for (const said of ["create a new note", "send a message", "add a reminder", "take a photo"]) {
    assert.equal(repairAppNames(said, apps).text, said, said);
  }
});

test("a two-consonant word is not rewritten on one consonant's evidence", () => {
  // From real use: "take a photo" came out as "take a Phone" and opened Phone.
  const r = repairAppNames("Take a photo.", ["Phone", "Photos", "Photo Booth", "FaceTime"]);
  assert.equal(r.text, "Take a photo.");
  assert.deepEqual(r.repairs, []);
});
