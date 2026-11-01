import assert from "node:assert/strict";
import test from "node:test";
import { allowedAgentsForWorkspace, assertAgentsAllowed } from "./workspace-policy.js";

test("company defaults to Claude and Grok and cannot enable Codex", () => {
  assert.deepEqual(allowedAgentsForWorkspace("company"), ["claude", "grok"]);
  assert.deepEqual(allowedAgentsForWorkspace("company", ["codex", "claude"]), ["claude"]);
});

test("personal defaults to every agent and honors a configured subset", () => {
  assert.deepEqual(allowedAgentsForWorkspace("personal"), ["codex", "claude", "grok"]);
  assert.deepEqual(allowedAgentsForWorkspace("personal", ["grok", "grok", "claude"]), ["grok", "claude"]);
});

test("assertAgentsAllowed reports a blocked agent before a CLI can start", () => {
  assert.throws(
    () => assertAgentsAllowed("company", ["claude", "codex"], ["claude", "grok"]),
    /회사 공간에서는 Codex를 사용할 수 없습니다/,
  );
});
