import test from "node:test";
import assert from "node:assert/strict";
import { changeWorkerConfig, teamAvailabilityWarning } from "./team";

test("a single provider can run a team while unavailable selections still block it", () => {
  assert.equal(teamAvailabilityWarning(["codex"], []), "");
  assert.match(teamAvailabilityWarning([], []), /한 개 이상/);
  assert.match(teamAvailabilityWarning(["codex"], ["claude"]), /Claude CLI/);
});

test("changing a worker provider retains its identity and refreshes duplicate labels", () => {
  const crew = [{ id: "one", label: "Claude", agent: "claude" as const, model: "sonnet" }, { id: "two", label: "Codex", agent: "codex" as const, model: "gpt" }];
  const next = changeWorkerConfig(crew, 0, { ...crew[0], agent: "codex", model: undefined });
  assert.deepEqual(next.map(({ id, label, agent, model }) => ({ id, label, agent, model })), [
    { id: "one", label: "Codex 1", agent: "codex", model: undefined },
    { id: "two", label: "Codex 2", agent: "codex", model: "gpt" },
  ]);
});

import { isNetworkFailure } from "./team";
test("network failures are recognised and not real request errors", () => {
  assert.ok(isNetworkFailure("Load failed"));
  assert.ok(isNetworkFailure("Failed to fetch"));
  assert.ok(!isNetworkFailure("Codex CLI를 시작할 수 없습니다."));
});
