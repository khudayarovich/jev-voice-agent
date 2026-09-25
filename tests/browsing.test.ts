import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseTab,
  clickTarget,
  isBlankPage,
  isSearchResults,
  landedOn,
  looksDestructive,
  resultNumber,
  samePage,
} from "../src/main/actions/browsing.ts";
import { ACTIONS } from "../src/main/actions/registry.ts";

/**
 * Browsing in the tab the user is on. From real use: "open browser", "search
 * for YouTube", "open YouTube" produced three windows where a person would
 * have used one tab.
 */

test("an empty tab is a place to start from", () => {
  for (const url of ["", "about:blank", "chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/", "favorites://"]) {
    assert.ok(isBlankPage(url), url);
  }
  assert.ok(!isBlankPage("https://example.com/"));
});

test("knows a page of search results", () => {
  for (const url of [
    "https://www.google.com/search?q=youtube&sca_esv=1",
    "https://www.google.co.uk/search?q=cats",
    "https://www.bing.com/search?q=cats",
    "https://duckduckgo.com/?q=cats",
    "https://www.youtube.com/results?search_query=lofi",
    "https://github.com/search?q=jev",
    "https://www.amazon.com/s?k=usb+cable",
  ]) {
    assert.ok(isSearchResults(url), url);
  }
  for (const url of ["https://www.google.com/", "https://www.youtube.com/watch?v=1", "https://github.com/khudayarovich", "not a url"]) {
    assert.ok(!isSearchResults(url), url);
  }
});

test("an empty tab or a results page is reused; anything else keeps its tab", () => {
  assert.equal(chooseTab("chrome://newtab/"), "current");
  assert.equal(chooseTab("https://www.google.com/search?q=youtube"), "current");
  assert.equal(chooseTab("https://www.nytimes.com/2026/09/25/story.html"), "new-tab");
  assert.equal(chooseTab(null), "new-tab", "no tab to look at: never overwrite blindly");
});

test("the page just opened by voice is reused, until the user goes elsewhere", () => {
  assert.equal(chooseTab("https://www.youtube.com/", "youtube.com"), "current");
  assert.equal(chooseTab("https://www.youtube.com/watch?v=abc", "youtube.com"), "new-tab");
});

test("same page, whatever the scheme, www or trailing slash", () => {
  assert.ok(samePage("https://www.youtube.com/", "youtube.com"));
  assert.ok(samePage("http://github.com/search", "https://www.github.com/search/"));
  assert.ok(!samePage("https://www.youtube.com/watch", "youtube.com"));
});

test("a page has arrived only when it is the search that was asked for", () => {
  const asked = "https://www.google.com/search?q=cats";
  assert.ok(landedOn("https://www.google.com/search?q=cats&sca_esv=9&ei=x", asked));
  assert.ok(!landedOn("https://www.google.com/search?q=dogs", asked), "the previous search is not the new one");
  assert.ok(landedOn("https://www.youtube.com/", "youtube.com"));
  assert.ok(!landedOn("chrome://new-tab-page/", "youtube.com"));
});

test("lifts what to click out of the request", () => {
  assert.equal(clickTarget("click youtube"), "youtube");
  assert.equal(clickTarget("click on the Sign in button."), "Sign in");
  assert.equal(clickTarget("press the continue button"), "continue");
  assert.equal(clickTarget("open the second result"), "second result");
  assert.equal(clickTarget("tap images"), "images");
  assert.equal(clickTarget("hello there"), null);
});

test("counts results, and only results", () => {
  assert.equal(resultNumber("first result"), 1);
  assert.equal(resultNumber("the top result"), 1);
  assert.equal(resultNumber("second link"), 2);
  assert.equal(resultNumber("3rd video"), 3);
  assert.equal(resultNumber("first one"), 1);
  assert.equal(resultNumber("first"), 1);
  assert.equal(resultNumber("youtube"), null);
  assert.equal(resultNumber("first class tickets"), null, "a name that starts with a number word");
});

test("clicking something destructive asks first; anything else does not", () => {
  const confirm = ACTIONS.click_on.confirmIf!;
  for (const target of ["Delete account", "send", "Buy now", "Sign out", "Empty Trash"]) {
    assert.ok(looksDestructive(target), target);
    assert.ok(confirm({ target }), target);
  }
  for (const target of ["YouTube", "Images", "Sign in", "first result", "Continue"]) {
    assert.ok(!confirm({ target }), target);
  }
});

test("playing a video means clicking one", () => {
  assert.equal(clickTarget("play some video from YouTube."), "some video");
  assert.equal(resultNumber("some video"), 1);
  assert.equal(resultNumber("a video"), 1);
  assert.equal(clickTarget("play the first video"), "first video");
  assert.equal(clickTarget("click on Wi-Fi."), "Wi-Fi");
});

test("what to click, without where it is or an article", () => {
  // From real use: "click on a radio from the sidebar menu" looked for a
  // button called "a radio from the sidebar menu".
  assert.equal(clickTarget("click on a radio."), "radio");
  assert.equal(clickTarget("click on a radio from the sidebar menu."), "radio");
  assert.equal(clickTarget("click radio in the sidebar"), "radio");
  assert.equal(clickTarget("play a video"), "a video", "still the first video");
});
