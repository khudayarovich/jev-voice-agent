import assert from "node:assert/strict";
import { test } from "node:test";
import { switchesInputSource } from "../src/main/hotkey-conflict.ts";

const DEFAULTS = `{
    60 =     {
        enabled = 1;
        value =         {
            parameters =             (
                32,
                49,
                262144
            );
            type = standard;
        };
    };
    61 =     {
        enabled = 1;
        value =         {
            parameters =             (
                32,
                49,
                786432
            );
            type = standard;
        };
    };
    64 =     {
        enabled = 0;
        value =         {
            parameters =             (
                32,
                49,
                1048576
            );
            type = standard;
        };
    };
}`;

test("Ctrl+Space is the layout switch on a Mac with several keyboards", () => {
  // From real use: the agent took it, and every layout switch poked the agent.
  assert.equal(switchesInputSource(DEFAULTS, "Control+Space"), true);
  assert.equal(switchesInputSource(DEFAULTS, "Control+Option+Space"), true, "the next-source key too");
  assert.equal(switchesInputSource(DEFAULTS, "Control+Shift+Space"), false, "the default, free");
  assert.equal(switchesInputSource(DEFAULTS, "Command+Space"), false, "Spotlight's, but not a layout switch");
  assert.equal(switchesInputSource("", "Control+Space"), false);
});
