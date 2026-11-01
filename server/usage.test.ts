import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendUsage, loadUsage, parseCliUsage } from "./usage.js";

test("parseCliUsage reads the terminal Codex token report without inventing cost", () => {
  const parsed = parseCliUsage("codex", JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 12 },
  }));
  assert.deepEqual(parsed, { tokens: { input: 120, cached: 80, output: 30, reasoning: 12 } });
});

test("parseCliUsage reads Claude result usage, reported cost, model, and plan limits", () => {
  const parsed = parseCliUsage("claude", JSON.stringify({
    type: "result",
    usage: { input_tokens: 90, cache_read_input_tokens: 60, output_tokens: 20 },
    total_cost_usd: 0.0042,
    modelUsage: { "claude-sonnet-4-5": { inputTokens: 90, outputTokens: 20 } },
    rate_limits: { five_hour: { utilization: 0.25, resets_at: "2026-10-30T15:00:00Z" } },
  }));
  assert.deepEqual(parsed, {
    tokens: { input: 90, cached: 60, output: 20 }, costUsd: 0.0042, model: "claude-sonnet-4-5",
    planLimits: { five_hour: { utilization: 0.25, resets_at: "2026-10-30T15:00:00Z" } },
  });
});

test("parseCliUsage preserves Claude cost when a result omits token usage", () => {
  assert.deepEqual(parseCliUsage("claude", JSON.stringify({
    type: "result", total_cost_usd: 0.0075, model: "claude-haiku-4-5",
  })), { costUsd: 0.0075, model: "claude-haiku-4-5" });
});

test("parseCliUsage captures Codex model metadata before its terminal usage event", () => {
  assert.deepEqual(parseCliUsage("codex", JSON.stringify({
    type: "thread.started", thread_id: "thread-1", model: "gpt-5.3-codex",
  })), { model: "gpt-5.3-codex" });
});

test("parseCliUsage reads Grok ACP camel-case usage and permits usage-free runs", () => {
  assert.deepEqual(parseCliUsage("grok", JSON.stringify({
    sessionId: "grok-session", stopReason: "end_turn",
    usage: { inputTokens: 70, cacheReadInputTokens: 50, outputTokens: 9, reasoningTokens: 4 },
    modelUsage: { "grok-4.6-build": { inputTokens: 70, outputTokens: 9 } },
  })), { tokens: { input: 70, cached: 50, output: 9, reasoning: 4 }, model: "grok-4.6-build" });
  assert.equal(parseCliUsage("grok", JSON.stringify({ sessionId: "grok-session", stopReason: "end_turn" })), undefined);
});

test("parseCliUsage reads Grok's standalone ACP usage line", () => {
  assert.deepEqual(parseCliUsage("grok", JSON.stringify({
    messageId: "message-1", inputTokens: 25, cacheReadInputTokens: 20, outputTokens: 4,
    modelUsage: { "grok-code-fast-1": { inputTokens: 25, outputTokens: 4 } },
  })), { tokens: { input: 25, cached: 20, output: 4 }, model: "grok-code-fast-1" });
});

test("usage records append atomically and preserve runs that have no token report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-orchestra-usage-"));
  await Promise.all([
    appendUsage({ id: "one", agent: "grok", model: "CLI default", workspaceId: "personal", sessionId: "session-1", role: "worker", durationMs: 250, status: "completed", timestamp: "2026-10-30T01:00:00.000Z" }, directory),
    appendUsage({ id: "two", agent: "claude", model: "sonnet", workspaceId: "company", sessionId: "session-2", role: "orchestrator", tokens: { input: 10, output: 2 }, costUsd: 0.01, durationMs: 300, status: "completed", timestamp: "2026-10-30T02:00:00.000Z" }, directory),
  ]);
  const records = await loadUsage(directory);
  assert.equal(records.length, 2);
  assert.equal(records.find((record) => record.id === "one")?.tokens, undefined);
  assert.equal(records.find((record) => record.id === "two")?.costUsd, 0.01);
});
