import assert from "node:assert/strict";
import test from "node:test";
import {
  isComputerUseAllowed, allowedAgentsForWorkspace, assertAgentsAllowed, assertMediaAllowed, defaultWorkspacePolicy, isToolLocked, lockedToolsFor,
  normalizeWorkspacePolicy, policyDenyPatterns, workspacePolicyErrorCode, WorkspacePolicyError, WorkspacePolicyInputError,
} from "./workspace-policy.js";

test("no workspace id is special: every workspace defaults to every agent and honors a configured subset", () => {
  for (const id of ["personal", "company", "default", "team-a"]) {
    assert.deepEqual(allowedAgentsForWorkspace(id), ["codex", "claude", "grok"]);
    assert.deepEqual(allowedAgentsForWorkspace(id, ["grok", "grok", "claude"]), ["grok", "claude"]);
  }
  assert.deepEqual(allowedAgentsForWorkspace("company", ["codex", "claude"]), ["codex", "claude"]);
});

test("assertAgentsAllowed reports a blocked agent as a workspace setting before a CLI can start", () => {
  assert.throws(
    () => assertAgentsAllowed("company", ["claude", "codex"], ["claude", "grok"]),
    (error: unknown) => error instanceof WorkspacePolicyError && error.code === workspacePolicyErrorCode && /작업 공간 설정에서 Codex 사용이 꺼져 있습니다/.test(error.message),
  );
  assert.doesNotThrow(() => assertAgentsAllowed("team", ["codex"]));
});

test("the default policy allows media, Grok MCP and every tool", () => {
  const policy = defaultWorkspacePolicy();
  assert.deepEqual(policy, { mediaGeneration: true, computerUse: false, grokMcp: true, blockedTools: [], authAlertTools: [] });
  assert.doesNotThrow(() => assertMediaAllowed(policy));
  assert.doesNotThrow(() => assertMediaAllowed(undefined));
  assert.deepEqual(policyDenyPatterns(policy, "grok"), []);
});

test("media off throws a workspace policy error", () => {
  assert.throws(() => assertMediaAllowed({ ...defaultWorkspacePolicy(), mediaGeneration: false }), (error: unknown) =>
    error instanceof WorkspacePolicyError && /이미지·영상 생성이 꺼져/.test(error.message));
});

test("blocked tools apply to every agent or to one agent", () => {
  const policy = { ...defaultWorkspacePolicy(), blockedTools: ["media-tool", "claude:docs"] };
  assert.deepEqual(lockedToolsFor(policy, "claude"), ["media-tool", "docs"]);
  assert.deepEqual(lockedToolsFor(policy, "grok"), ["media-tool"]);
  assert.equal(isToolLocked(policy, "codex", "Media-Tool"), true);
  assert.equal(isToolLocked(policy, "codex", "docs"), false);
  assert.deepEqual(policyDenyPatterns(policy, "claude"), ["mcp__media-tool__*", "mcp__docs__*"]);
  assert.deepEqual(policyDenyPatterns({ ...policy, grokMcp: false }, "grok"), ["mcp__media-tool__*", "mcp__*"]);
  assert.deepEqual(policyDenyPatterns({ ...policy, grokMcp: false }, "codex"), ["mcp__media-tool__*"]);
});

test("strict validation rejects bad input; stored data falls back to defaults", () => {
  const bad = [
    "nope", [], { mediaGeneration: "yes" }, { grokMcp: 1 }, { blockedTools: "x" }, { blockedTools: ["bad name"] },
    { blockedTools: ["nobody:tool"] }, { authAlertTools: [3] }, { mediaPrompt: 5 }, { computerUse: "on" }, { mediaPrompt: "x".repeat(4_001) },
    { blockedTools: Array.from({ length: 101 }, (_value, index) => `t${index}`) },
  ];
  for (const value of bad) assert.throws(() => normalizeWorkspacePolicy(value, true), WorkspacePolicyInputError, JSON.stringify(value).slice(0, 80));
  assert.deepEqual(normalizeWorkspacePolicy({ mediaGeneration: "yes", blockedTools: ["ok", "bad name", "OK", "grok:x"] }),
    { ...defaultWorkspacePolicy(), blockedTools: ["ok", "grok:x"] });
});

test("partial updates merge onto the stored policy and an empty media prompt clears it", () => {
  const stored = { mediaGeneration: false, computerUse: false, grokMcp: true, blockedTools: ["a"], authAlertTools: ["a"], mediaPrompt: "hint" };
  assert.deepEqual(normalizeWorkspacePolicy({ grokMcp: false }, true, stored), { ...stored, grokMcp: false });
  assert.deepEqual(normalizeWorkspacePolicy({ mediaPrompt: "" }, true, stored), { mediaGeneration: false, computerUse: false, grokMcp: true, blockedTools: ["a"], authAlertTools: ["a"] });
  assert.deepEqual(normalizeWorkspacePolicy({ blockedTools: [" b "] }, true, stored).blockedTools, ["b"]);
});

test("computer control is off unless a workspace turns it on", () => {
  assert.equal(defaultWorkspacePolicy().computerUse, false);
  const state = { settings: { a: { ...defaultWorkspacePolicy(), computerUse: true }, b: defaultWorkspacePolicy() } };
  assert.equal(isComputerUseAllowed(state, "a"), true);
  assert.equal(isComputerUseAllowed(state, "b"), false);
  assert.equal(isComputerUseAllowed(state, "missing"), false);
  assert.equal(isComputerUseAllowed(undefined, "a"), false);
  assert.equal(normalizeWorkspacePolicy({ computerUse: true }, true).computerUse, true);
});
