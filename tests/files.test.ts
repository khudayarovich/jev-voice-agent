import assert from "node:assert/strict";
import { test } from "node:test";
import { newFolderName, renameRequest, shortlistFolders } from "../src/main/actions/files.ts";

test("a rename names the item and the new name, or just the new name", () => {
  // From real use, each of these was routed to typing text and rejected.
  assert.deepEqual(renameRequest("Rename the untitled folder on the desktop to a hello world."), { item: "untitled folder", to: "hello world" });
  assert.deepEqual(renameRequest("rename the folder on the desktop to Hello World"), { item: null, to: "Hello World" });
  assert.deepEqual(renameRequest("And the name the folder as hello."), { item: null, to: "hello" });
  assert.deepEqual(renameRequest("rename it to reports"), { item: null, to: "reports" });
  assert.deepEqual(renameRequest("rename budget.xlsx to budget 2026"), { item: "budget.xlsx", to: "budget 2026" });
  assert.deepEqual(renameRequest("rename the folder"), { item: null, to: null });
});

test("a new folder takes the name said, if any", () => {
  assert.equal(newFolderName("make a new folder called reports"), "reports");
  assert.equal(newFolderName("create a folder named photos on the desktop"), "photos");
  assert.equal(newFolderName("create a new folder on the desktop"), null);
});

test("the folder asked for is found by its name", () => {
  assert.deepEqual(shortlistFolders("open the downloads folder"), ["Downloads"]);
  assert.deepEqual(shortlistFolders("show my desktop folder"), ["Desktop"]);
  assert.deepEqual(shortlistFolders("open safari"), []);
});
