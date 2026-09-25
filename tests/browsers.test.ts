import assert from "node:assert/strict";
import { test } from "node:test";
import { browseScript, frontTabScript, parseFrontTab, scriptFamily } from "../src/main/platform/macos/browsers.ts";

test("knows which browsers can be scripted, and how", () => {
  assert.equal(scriptFamily("Safari"), "safari");
  assert.equal(scriptFamily("Google Chrome"), "chromium");
  assert.equal(scriptFamily("Microsoft Edge"), "chromium");
  assert.equal(scriptFamily("Brave Browser"), "chromium");
  assert.equal(scriptFamily("Firefox"), null, "no tab dictionary: opened with open -a");
});

test("loads a page into the front tab, or a new tab of the front window — never a new window", () => {
  const url = "https://www.google.com/search?q=cats";
  const current = browseScript("Google Chrome", "chromium", url, "current");
  assert.match(current, /set URL of active tab of w to "https:\/\/www\.google\.com\/search\?q=cats"/);
  assert.doesNotMatch(current.replace(/if \(count of windows\) is 0 then[\s\S]*?else/, ""), /make new window/);

  const tab = browseScript("Safari", "safari", url, "new-tab");
  assert.match(tab, /make new tab at end of tabs with properties \{URL:"https:\/\/www\.google\.com\/search\?q=cats"\}/);
  assert.match(tab, /make new document/, "only when Safari has no window at all");
});

test("a quote in an address cannot break out of the script", () => {
  const script = browseScript("Safari", "safari", 'https://example.com/"; do shell script "x', "current");
  assert.ok(script.includes('https://example.com/\\"; do shell script \\"x'));
});

test("reads the front tab's address and title", () => {
  assert.deepEqual(parseFrontTab("https://www.google.com/search?q=cats\ncats - Google Search\n"), {
    url: "https://www.google.com/search?q=cats",
    title: "cats - Google Search",
  });
  assert.deepEqual(parseFrontTab("\nStart Page"), { url: "", title: "Start Page" }, "Safari's start page has no address");
  assert.equal(parseFrontTab(""), null, "no window");
  assert.match(frontTabScript("Safari", "safari"), /missing value/);
});
