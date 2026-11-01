import assert from "node:assert/strict";
import test from "node:test";
import {
  equivalentFallbackModel,
  exhaustionFromQuota,
  isQuotaExhaustion,
  selectQuotaFallback,
} from "./quota-fallback.js";

test("detects provider quota exhaustion messages and structured events", () => {
  assert.equal(isQuotaExhaustion("You have 0 weighted tokens left — usage limit reached"), true);
  assert.equal(isQuotaExhaustion('{"type":"error","code":"rate_limit_exceeded","status":429}'), true);
  assert.equal(isQuotaExhaustion('{"type":"rate_limit_event","status":"rejected"}'), true);
  assert.equal(isQuotaExhaustion('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}'), true);
  assert.equal(isQuotaExhaustion('{"type":"rate_limit_event","status":"allowed"}'), false);
  assert.equal(isQuotaExhaustion('info: {"type":"rate_limit_event","status":"allowed","rate_limit_info":{}}'), false);
  assert.equal(isQuotaExhaustion('{"type":"rate_limit","status":"rejected"}'), true);
  assert.equal(isQuotaExhaustion('{"type":"rate_limit","status":"allowed"}'), false);
  assert.equal(isQuotaExhaustion('{"type":"error","code":"rate_limit"}'), true);
  assert.equal(isQuotaExhaustion("Grok API error: quota exceeded (429)"), true);
  assert.equal(isQuotaExhaustion("request failed: invalid prompt"), false);
});

test("quota threshold uses the limiting window and exposes its reset", () => {
  assert.deepEqual(exhaustionFromQuota({
    agent: "codex",
    windows: [
      { key: "five", label: "5시간", remainingPercent: 2, resetsAt: 1_800 },
      { key: "week", label: "주간", remainingPercent: 40, resetsAt: 9_000 },
    ],
  }, 3, 1_000), { exhausted: true, remainingPercent: 2, resetsAt: 1_800 });
  assert.equal(exhaustionFromQuota({ agent: "codex", windows: [{ key: "five", label: "5시간", remainingPercent: 3.01 }] }, 3).exhausted, false);
  assert.equal(exhaustionFromQuota({ agent: "codex", windows: [{ key: "old", label: "old", remainingPercent: 0, resetsAt: 900 }] }, 3, 1_000).exhausted, false);
  assert.equal(exhaustionFromQuota({ agent: "codex", updatedAt: "2020-01-01T00:00:00Z", windows: [{ key: "stale", label: "stale", remainingPercent: 0 }] }, 3, 2_000_000_000).exhausted, false);
});

test("selects the authenticated allowed fallback with most remaining quota and honors company policy", () => {
  const quotas = [
    { agent: "claude" as const, windows: [{ key: "a", label: "a", remainingPercent: 60 }] },
    { agent: "grok" as const, windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
    { agent: "codex" as const, windows: [{ key: "a", label: "a", remainingPercent: 99 }] },
  ];
  assert.equal(selectQuotaFallback("codex", ["codex", "claude", "grok"], ["claude", "grok"], quotas), "grok");
  assert.equal(selectQuotaFallback("claude", ["codex", "grok"], ["codex", "grok"], quotas, undefined, "company"), "grok");
});

test("fallback order breaks remaining-quota ties and model tier is preserved", () => {
  const quotas = [
    { agent: "claude" as const, windows: [{ key: "a", label: "a", remainingPercent: 50 }] },
    { agent: "grok" as const, windows: [{ key: "a", label: "a", remainingPercent: 50 }] },
  ];
  assert.equal(selectQuotaFallback("codex", ["claude", "grok"], ["claude", "grok"], quotas, { codex: ["grok", "claude"] }), "grok");
  assert.deepEqual(equivalentFallbackModel("codex", "claude", "gpt-5-codex", "high"), { model: "sonnet", reasoningEffort: undefined });
  assert.deepEqual(equivalentFallbackModel("claude", "codex", "opus", undefined), { model: undefined, reasoningEffort: "high" });
  assert.deepEqual(equivalentFallbackModel("codex", "grok", undefined, "high"), { model: "grok-4.7", reasoningEffort: undefined });
  assert.deepEqual(equivalentFallbackModel("claude", "grok", "haiku", undefined), { model: "grok-4.7-build-fast", reasoningEffort: undefined });
});
