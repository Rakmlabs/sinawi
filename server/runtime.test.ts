import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runtimeOptions } from "./runtime.js";

test("only start mode serves frontend files and honors the packaged static directory", () => {
  assert.equal(runtimeOptions([], {}).staticDir, undefined);
  assert.equal(runtimeOptions(["start"], { AGENT_ORCHESTRA_STATIC_DIR: "/tmp/Orchestra Resources/dist" }).staticDir, resolve("/tmp/Orchestra Resources/dist"));
  assert.ok(runtimeOptions(["start"], {}).staticDir?.endsWith("/dist"));
});

test("runtime configures a positive finite inactivity timeout with a ten-minute default", () => {
  assert.equal(runtimeOptions([], {}).inactivityTimeoutMs, 600_000);
  assert.equal(runtimeOptions([], { AGENT_ORCHESTRA_INACTIVITY_TIMEOUT_MS: "1500" }).inactivityTimeoutMs, 1_500);
  for (const value of ["0", "-1", "Infinity", "not-a-number", ""]) {
    assert.equal(runtimeOptions([], { AGENT_ORCHESTRA_INACTIVITY_TIMEOUT_MS: value }).inactivityTimeoutMs, 600_000);
  }
});
