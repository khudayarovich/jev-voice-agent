import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDisplayName, parseForegroundApps } from "../src/main/platform/macos/lsappinfo.ts";

const LISTING = `
 1) "loginwindow" ASN:0x0-0x1001:
    bundleID="com.apple.loginwindow"
    pid = 171 type="UIElement" flavor=3 Version="3085.5.3" fileType="APPL" creator="lgnw" Arch=ARM64
 5) "Dock" ASN:0x0-0xb00b:
    bundleID="com.apple.dock"
    pid = 432 type="UIElement" flavor=4 Version="2427.4.7" fileType="APPL" creator="dock" Arch=ARM64
 40) "Finder" ASN:0x0-0x24024:
    bundleID="com.apple.finder"
    pid = 549 type="Foreground" flavor=3 Version="4617" fileType="APPL" creator="????" Arch=ARM64
100) "Google Chrome" ASN:0x0-0x63d63d:
    bundleID="com.google.Chrome"
    bundle path="/Applications/Google Chrome.app"
    pid = 44964 type="Foreground" flavor=3 Version="8010.53" fileType="APPL" creator="rimZ" Arch=ARM64
101) "universalaccessd" ASN:0x0-0x9009:
    pid = 416 !signalled type="BackgroundOnly" flavor=3 Version=[ NULL ]
`;

test("lists the regular apps, with their real names", () => {
  assert.deepEqual(parseForegroundApps(LISTING), ["Finder", "Google Chrome"]);
});

test("ignores agents and background processes", () => {
  const apps = parseForegroundApps(LISTING);
  assert.ok(!apps.includes("Dock"));
  assert.ok(!apps.includes("loginwindow"));
  assert.ok(!apps.includes("universalaccessd"));
});

test("copes with nothing to parse", () => {
  assert.deepEqual(parseForegroundApps(""), []);
});

test("reads the display name of the frontmost app", () => {
  assert.equal(parseDisplayName(`"LSDisplayName"="Google Chrome"\n`), "Google Chrome");
  assert.equal(parseDisplayName(""), "");
});
