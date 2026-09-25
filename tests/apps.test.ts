import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_BROWSERS,
  describeApp,
  expandApps,
  isBrowser,
  listNames,
  namedBrowser,
  pickBrowser,
  refersToBrowser,
  wantsAll,
  withoutBrowser,
} from "../src/main/actions/apps.ts";
import type { ActionContext } from "../src/main/actions/types.ts";

/**
 * Which browser a link opens in, and how apps are described to the model.
 *
 * The failure these guard against, from real use: "open my browser" opened
 * Chrome, then "search for YouTube" opened Safari — the system default — so the
 * user had two browsers and the result in the one they were not looking at.
 */

function ctx(transcript: string, extra: Partial<ActionContext> = {}): ActionContext {
  return {
    transcript,
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: ["Finder"],
    installedApps: ["Google Chrome", "Safari", "Firefox", "Photo Booth", "Terminal"],
    automations: [],
    defaultBrowser: "Safari",
    ...extra,
  };
}

test("a link opens in the browser in front", () => {
  const c = ctx("open youtube", { focusedApp: "Google Chrome", runningApps: ["Finder", "Safari", "Google Chrome"] });
  assert.equal(pickBrowser(c), "Google Chrome");
});

test("a named browser wins over everything", () => {
  const c = ctx("open youtube in firefox", { focusedApp: "Google Chrome", runningApps: ["Google Chrome"] });
  assert.equal(pickBrowser(c), "Firefox");
  assert.equal(pickBrowser(ctx("search for cats using the chrome browser")), "Google Chrome");
});

test("a browser that is not installed is not named", () => {
  assert.equal(namedBrowser("open youtube in edge", ["Safari"]), null);
});

test("the browser just used by voice is used again", () => {
  const c = ctx("search for cats", { focusedApp: "Terminal", lastBrowser: "Google Chrome" });
  assert.equal(pickBrowser(c), "Google Chrome");
});

test("the only open browser is used rather than launching the default", () => {
  const c = ctx("open github", { runningApps: ["Finder", "Google Chrome"] });
  assert.equal(pickBrowser(c), "Google Chrome");
});

test("with the default browser open, the default is left to decide", () => {
  const c = ctx("open github", { runningApps: ["Safari", "Google Chrome"] });
  assert.equal(pickBrowser(c), null);
});

test("with no browser open, the default opens", () => {
  assert.equal(pickBrowser(ctx("open github")), null);
});

test("with several open and none of them the default, the most recently used", () => {
  const c = ctx("open github", {
    runningApps: ["Firefox", "Google Chrome"],
    installedApps: ["Google Chrome", "Firefox", "Safari"],
  });
  assert.equal(pickBrowser(c), "Google Chrome");
});

test("the browser mention is not part of the request's text", () => {
  assert.equal(withoutBrowser("search for cats in chrome"), "search for cats");
  assert.equal(withoutBrowser("open youtube in google chrome."), "open youtube");
  assert.equal(withoutBrowser("search for the edge of tomorrow"), "search for the edge of tomorrow");
  assert.equal(withoutBrowser("search for cats"), "search for cats");
});

test("knows a browser when it sees one", () => {
  assert.ok(isBrowser("Google Chrome"));
  assert.ok(isBrowser("safari"));
  assert.ok(!isBrowser("Photo Booth"));
});

test("describes the camera app so a description can find it", () => {
  assert.match(describeApp("Photo Booth") ?? "", /camera/i);
  assert.match(describeApp("Photo Booth") ?? "", /selfie/i);
  assert.equal(describeApp("Some Unknown App"), null);
});

test("says which browser is the default, in use, or in front", () => {
  const notes = { defaultBrowser: "Safari", lastBrowser: "Google Chrome", running: new Set(["Google Chrome", "Safari"]) };
  assert.match(describeApp("Safari", notes) ?? "", /default browser/);
  assert.match(describeApp("Google Chrome", notes) ?? "", /just used/);
  assert.match(describeApp("Terminal", { frontmost: "Terminal" }) ?? "", /in front/);
  assert.match(describeApp("Safari", notes) ?? "", /open now/);
});

test("'all the browsers' asks for the group; one browser does not", () => {
  assert.ok(wantsAll("close all browsers"));
  assert.ok(wantsAll("quit both browsers"));
  assert.ok(wantsAll("close every browser"));
  assert.ok(!wantsAll("close the browser"));
  assert.ok(!wantsAll("close all windows"));
});

test("the group stands for every open browser", () => {
  assert.deepEqual(expandApps(ALL_BROWSERS, ["Finder", "Safari", "Google Chrome"]), ["Safari", "Google Chrome"]);
  assert.deepEqual(expandApps("Safari", ["Finder"]), ["Safari"]);
});

test("lists names the way a person would", () => {
  assert.equal(listNames(["Safari"]), "Safari");
  assert.equal(listNames(["Safari", "Chrome"]), "Safari and Chrome");
  assert.equal(listNames(["Safari", "Chrome", "Firefox"]), "Safari, Chrome and Firefox");
});

test("knows 'the browser' from a browser by name", () => {
  assert.ok(refersToBrowser("open my browser"));
  assert.ok(refersToBrowser("close the web browser"));
  assert.ok(!refersToBrowser("open the chrome browser"));
  assert.ok(!refersToBrowser("open safari"));
});
