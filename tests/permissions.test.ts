import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCdhash, signingIdentity } from "../src/main/permissions/cdhash.ts";

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

test("grants are keyed by the certificate when there is one, else by the build's hash", () => {
  const adhoc = "Identifier=ai.jev.voiceagent\nCDHash=5f1e2d3c\nSignature=adhoc\n";
  assert.equal(signingIdentity(adhoc), "cdhash:5f1e2d3c");
  const signed = "Identifier=ai.jev.voiceagent\nCDHash=aabbccdd\nSignature size=4785\nAuthority=JVA Dev\nSigned Time=…\n";
  assert.equal(signingIdentity(signed), "cert:JVA Dev");
  assert.equal(signingIdentity("code object is not signed at all"), null);
});
