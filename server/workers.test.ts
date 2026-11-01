import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerConfigs } from "./workers.js";

test("normalizes duplicate agents into stable worker identities and labels", () => {
  assert.deepEqual(normalizeWorkerConfigs(["codex", "codex"], [
    { agent: "codex", model: "gpt-a" },
    { agent: "codex", model: "gpt-b" },
  ]), [
    { id: "codex-1", label: "Codex 1", agent: "codex", model: "gpt-a" },
    { id: "codex-2", label: "Codex 2", agent: "codex", model: "gpt-b" },
  ]);
});

test("preserves explicit unique worker ids and labels", () => {
  assert.deepEqual(normalizeWorkerConfigs(["claude", "claude"], [
    { id: "reviewer", label: "Review", agent: "claude" },
    { id: "builder", agent: "claude" },
  ]), [
    { id: "reviewer", label: "Review", agent: "claude" },
    { id: "builder", label: "Claude 2", agent: "claude" },
  ]);
});

test("uses the legacy agent id for a single worker", () => {
  assert.deepEqual(normalizeWorkerConfigs(["grok"]), [{ id: "grok", label: "Grok Build", agent: "grok" }]);
});

test("avoids future explicit id collisions and renumbers a former singleton label", () => {
  assert.deepEqual(normalizeWorkerConfigs(["codex", "codex"], [
    { id: "codex-2", label: "Codex", agent: "codex" },
    { agent: "codex" },
  ]), [
    { id: "codex-2", label: "Codex 1", agent: "codex" },
    { id: "codex-3", label: "Codex 2", agent: "codex" },
  ]);
});

test("generated duplicate labels avoid stable labels retained by existing workers", () => {
  assert.deepEqual(normalizeWorkerConfigs(["codex", "codex"], [
    { id: "two", label: "Codex 2", agent: "codex" },
    { id: "new", agent: "codex" },
  ]).map(({ id, label }) => ({ id, label })), [
    { id: "two", label: "Codex 2" },
    { id: "new", label: "Codex 1" },
  ]);
});

test("invalid explicit worker ids fall back to delegation-safe generated ids", () => {
  assert.equal(normalizeWorkerConfigs(["claude"], [{ id: "not addressable", agent: "claude" }])[0].id, "claude");
});
