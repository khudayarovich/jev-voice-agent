import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultBrowserId, parseMdls, parseMdlsDate } from "../src/main/platform/macos/launchservices.ts";

const MDLS = `kMDItemCFBundleIdentifier = "com.apple.Safari"
kMDItemFSName             = "Safari.app"
kMDItemLastUsedDate       = 2026-09-25 11:20:07 +0000
kMDItemCFBundleIdentifier = "com.apple.PhotoBooth"
kMDItemFSName             = "Photo Booth.app"
kMDItemLastUsedDate       = (null)
kMDItemCFBundleIdentifier = "com.google.Chrome"
kMDItemFSName             = "Google Chrome.app"
kMDItemLastUsedDate       = 2026-09-25 11:21:02 +0000
`;

test("reads one record per app from mdls", () => {
  const records = parseMdls(MDLS);
  assert.equal(records.length, 3);
  assert.deepEqual(records[1], { kMDItemCFBundleIdentifier: "com.apple.PhotoBooth", kMDItemFSName: "Photo Booth.app" });
  assert.equal(records[2]?.kMDItemCFBundleIdentifier, "com.google.Chrome");
});

test("an app never opened has no last-used date, rather than a wrong one", () => {
  assert.equal(parseMdls(MDLS)[1]?.kMDItemLastUsedDate, undefined);
});

test("reads mdls dates, time zone included", () => {
  assert.equal(parseMdlsDate("2026-09-25 11:20:07 +0000"), Date.UTC(2026, 8, 25, 11, 20, 7));
  assert.equal(parseMdlsDate("2026-09-25 13:20:07 +0200"), Date.UTC(2026, 8, 25, 11, 20, 7));
  assert.equal(parseMdlsDate(undefined), undefined);
  assert.equal(parseMdlsDate("(null)"), undefined);
});

test("finds the default browser in the LaunchServices preferences", () => {
  const prefs = {
    LSHandlers: [
      { LSHandlerURLScheme: "tg", LSHandlerRoleAll: "com.tdesktop.telegram" },
      { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.google.chrome" },
      { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
    ],
  };
  assert.equal(defaultBrowserId(prefs), "com.google.chrome");
});

test("no choice recorded means the system default", () => {
  assert.equal(defaultBrowserId({ LSHandlers: [{ LSHandlerURLScheme: "tg", LSHandlerRoleAll: "x" }] }), null);
  assert.equal(defaultBrowserId({}), null);
  assert.equal(defaultBrowserId(null), null);
});
