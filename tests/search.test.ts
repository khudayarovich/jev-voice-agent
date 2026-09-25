import assert from "node:assert/strict";
import { test } from "node:test";
import { planSearch } from "../src/main/actions/parse.ts";

/**
 * Where a "search for …" goes. From real use: "search for youtube.com" ran a
 * Google search for the words "youtube.com", when the user wanted YouTube.
 */

test("an address given as the query opens it", () => {
  assert.deepEqual(planSearch("search for youtube.com", "youtube.com"), {
    url: "https://youtube.com", kind: "site", label: "youtube.com", query: "youtube.com",
  });
  assert.equal(planSearch("search for github dot com", "github dot com").url, "https://github.com");
});

test("a site's bare name is searched for, as the user then clicks the result", () => {
  const plan = planSearch("search for youtube", "youtube");
  assert.equal(plan.kind, "search");
  assert.equal(plan.url, "https://www.google.com/search?q=youtube");
});

test("a query that merely contains a site's name is a search", () => {
  const plan = planSearch("search for github copilot", "github copilot");
  assert.equal(plan.kind, "search");
  assert.equal(plan.url, "https://www.google.com/search?q=github%20copilot");
});

test("searching a site goes to that site's own search", () => {
  assert.equal(
    planSearch("search youtube for cats", "youtube for cats").url,
    "https://www.youtube.com/results?search_query=cats",
  );
  assert.equal(
    planSearch("search for cats on youtube", "cats on youtube").url,
    "https://www.youtube.com/results?search_query=cats",
  );
  assert.equal(
    planSearch("look up pizza near me on google maps", "pizza near me on google maps").url,
    "https://www.google.com/maps/search/pizza%20near%20me",
  );
});

test("playing something on YouTube searches YouTube for it", () => {
  const plan = planSearch("play lofi music on youtube", "lofi music on youtube");
  assert.equal(plan.url, "https://www.youtube.com/results?search_query=lofi%20music");
  assert.equal(plan.label, "YouTube");
  assert.equal(plan.query, "lofi music");
});

test("'there' means the site in the front window", () => {
  const plan = planSearch("search for cats there", "cats there", "lofi hip hop radio - YouTube");
  assert.equal(plan.url, "https://www.youtube.com/results?search_query=cats");
  // Nothing recognisable in front: an ordinary search, without the "there".
  assert.equal(planSearch("search for cats there", "cats there", "Inbox").url, "https://www.google.com/search?q=cats");
});

test("everything else is a web search, with the words kept as said", () => {
  const plan = planSearch("search for typescript generics", "typescript generics.");
  assert.equal(plan.url, "https://www.google.com/search?q=typescript%20generics");
  assert.equal(plan.query, "typescript generics");
  assert.equal(plan.label, "the web");
});
