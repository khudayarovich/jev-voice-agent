import assert from "node:assert/strict";
import { test } from "node:test";
import { wifiDevice } from "../src/main/platform/macos/network.ts";

test("finds the Wi-Fi interface, wherever it is", () => {
  const listing = `
Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: N/A

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 12:34:56:78:9a:bc
`;
  assert.equal(wifiDevice(listing), "en0");
  assert.equal(wifiDevice("Hardware Port: Wi-Fi\nDevice: en1\n"), "en1");
  assert.equal(wifiDevice("Hardware Port: Ethernet\nDevice: en0\n"), null, "no Wi-Fi at all");
});
