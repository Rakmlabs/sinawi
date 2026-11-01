import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, filterUsageRuns, usageBarWidth, type UsageRunRecord } from "./usage-data";

const now = new Date("2026-10-30T12:00:00.000Z");
const runs: UsageRunRecord[] = [
  { id: "1", agent: "claude", model: "claude-sonnet", workspaceId: "personal", sessionId: "a", role: "orchestrator", timestamp: "2026-10-30T01:00:00.000Z", durationMs: 2_000, status: "completed", tokens: { input: 100, cached: 40, output: 20, reasoning: 0 }, costUsd: 0.012 },
  { id: "2", agent: "codex", model: "gpt-5", workspaceId: "company", sessionId: "b", role: "worker", timestamp: "2026-10-24T08:00:00.000Z", durationMs: 5_000, status: "completed", tokens: { input: 50, output: 10, reasoning: 7 } },
  { id: "3", agent: "grok", model: "grok-code", workspaceId: "personal", sessionId: "c", role: "router", timestamp: "2026-09-01T08:00:00.000Z", durationMs: 1_000, status: "completed" },
];

test("usage period and workspace filters use calendar-day boundaries", () => {
  assert.deepEqual(filterUsageRuns(runs, "today", "all", now).map((run) => run.id), ["1"]);
  assert.deepEqual(filterUsageRuns(runs, "7d", "all", now).map((run) => run.id), ["1", "2"]);
  assert.deepEqual(filterUsageRuns(runs, "30d", "personal", now).map((run) => run.id), ["1"]);
});

test("usage aggregation totals reported tokens and preserves missing values", () => {
  const result = aggregateUsage(runs.slice(0, 2));
  assert.deepEqual(result.totals, { runs: 2, input: 150, cached: 40, output: 30, reasoning: 7, durationMs: 7_000, costUsd: 0.012, hasTokens: true, hasInput: true, hasCached: true, hasOutput: true, hasReasoning: true, hasCost: true });
  assert.deepEqual(result.byAgent.map((row) => [row.key, row.runs, row.totalTokens]), [["claude", 1, 120], ["codex", 1, 60]]);
  assert.deepEqual(result.byModel.map((row) => row.key), ["claude-sonnet", "gpt-5"]);

  const missing = aggregateUsage([runs[2]]);
  assert.equal(missing.totals.hasTokens, false);
  assert.equal(missing.totals.hasCost, false);
  assert.equal(missing.byModel[0].totalTokens, undefined);
});

test("usage aggregation does not turn an unreported token field into zero", () => {
  const partial = aggregateUsage([runs[1]]);
  assert.equal(partial.totals.hasInput, true);
  assert.equal(partial.totals.hasCached, false);
  assert.equal(partial.totals.cached, 0);
  assert.equal(partial.byModel[0].hasCached, false);
});

test("reasoning and cache alone do not fabricate an input-output total", () => {
  const partial: UsageRunRecord = { ...runs[1], tokens: { cached: 12, reasoning: 8 } };
  const result = aggregateUsage([partial]);
  assert.equal(result.byModel[0].totalTokens, undefined);
  assert.equal(result.byModel[0].reasoning, 8);
  assert.equal(result.byModel[0].cached, 12);
});

test("zero reported tokens do not draw a minimum usage bar", () => {
  assert.equal(usageBarWidth(0, 100), 0);
  assert.equal(usageBarWidth(undefined, 100), 0);
  assert.equal(usageBarWidth(1, 100), 3);
});
