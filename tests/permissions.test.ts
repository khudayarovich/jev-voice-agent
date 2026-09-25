import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCdhash } from "../src/main/permissions/cdhash.ts";

test("the code hash is read from codesign's report", () => {
  const report = [
    "Executable=/Applications/Jev Voice Agent.app/Contents/MacOS/Jev Voice Agent",
    "Identifier=ai.jev.voiceagent",
    "CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded",
    "Hash type=sha256 size=32",
    "CandidateCDHash sha256=5f1e2d3c4b5a69788796a5b4c3d2e1f00112233",
    "CDHash=5f1e2d3c4b5a69788796a5b4c3d2e1f00112233",
    "Signature=adhoc",
  ].join("\n");
  assert.equal(parseCdhash(report), "5f1e2d3c4b5a69788796a5b4c3d2e1f00112233");
  assert.equal(parseCdhash("code object is not signed at all"), null);
});
