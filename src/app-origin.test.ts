import test from "node:test";
import assert from "node:assert/strict";
import { isStrandedShell } from "./app-origin";

test("app shell on tauri:// (walked back past the server page) is detected as stranded", () => {
  assert.equal(isStrandedShell("tauri://localhost/"), true);
  assert.equal(isStrandedShell("about:blank"), true);
  assert.equal(isStrandedShell("not a url"), true);
  assert.equal(isStrandedShell("http://127.0.0.1:3001/"), false);
  assert.equal(isStrandedShell("http://127.0.0.1:5188/"), false);
});
