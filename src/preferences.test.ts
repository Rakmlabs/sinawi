import { test } from "node:test";
import assert from "node:assert/strict";
import { savedAutoSwitch, savedBoolean, savedMode, readPreference, writePreference } from "./preferences";
test("stored UI choices recover safely from missing or invalid values", () => {
  assert.equal(savedMode("manual"), "manual");
  for (const value of [null, "auto", "broken"]) assert.equal(savedMode(value), "auto");
  assert.equal(savedBoolean("true"), true);
  assert.equal(savedBoolean("false", true), false);
  assert.equal(savedBoolean("broken", true), true);
  assert.equal(savedBoolean(null), false);
  assert.equal(savedAutoSwitch(null), true);
  assert.equal(savedAutoSwitch("broken"), true);
  assert.equal(savedAutoSwitch("false"), false);
});
test("preferences tolerate unavailable browser storage", () => {
  assert.equal(readPreference("mode"), null);
  assert.doesNotThrow(() => writePreference("mode", "manual"));
});
