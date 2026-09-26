import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKey, newSalt, open, seal } from "../src/main/secrets.ts";

test("a secret sealed on this machine opens here, and nowhere else", () => {
  const salt = Buffer.from(newSalt(), "base64");
  const key = deriveKey("5F1E2D3C-UUID", "farrukh", salt);
  const box = seal(key, "sk-or-v1-abc123");
  assert.equal(open(key, box), "sk-or-v1-abc123");
  assert.match(box, /^s1\./);
  assert.ok(!box.includes("abc123"), "nothing in the clear");
  // Another machine, another user, another salt: not this one's.
  assert.equal(open(deriveKey("OTHER-UUID", "farrukh", salt), box), null);
  assert.equal(open(deriveKey("5F1E2D3C-UUID", "someone", salt), box), null);
  assert.equal(open(deriveKey("5F1E2D3C-UUID", "farrukh", Buffer.from(newSalt(), "base64")), box), null);
  // Tampered with: refused, not garbled.
  assert.equal(open(key, box.slice(0, -4) + "AAAA"), null);
  assert.equal(open(key, "garbage"), null);
});
