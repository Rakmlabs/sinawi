import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadProviderQuotas,
  parseProviderQuota,
  quotaEligibleAgents,
  saveProviderQuota,
  scanCodexQuota,
} from "./quota.js";

test("Codex rate_limits expose remaining percentages and Unix reset seconds", () => {
  const parsed = parseProviderQuota("codex", JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 70, window_minutes: 300, resets_at: 1_798_800_000 },
      secondary: { used_percent: 96, window_minutes: 10_080, resets_at: 1_799_000_000 },
      credits: { has_credits: true, balance: "12.5" },
    } },
  }), "2026-10-30T12:00:00.000Z");

  assert.deepEqual(parsed, {
    agent: "codex",
    windows: [
      { key: "primary", label: "5시간", remainingPercent: 30, resetsAt: 1_798_800_000 },
      { key: "secondary", label: "주간", remainingPercent: 4, resetsAt: 1_799_000_000 },
    ],
    credits: { has_credits: true, balance: "12.5" },
    updatedAt: "2026-10-30T12:00:00.000Z",
    source: "codex-session",
  });
});

test("Claude rate_limit_event prefers unified five-hour and seven-day windows", () => {
  const parsed = parseProviderQuota("claude", JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed", utilization: 0.96, resetsAt: "2026-10-30T15:00:00Z",
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: "2026-10-30T15:00:00Z", status: "allowed" },
        seven_day: { utilization: 0.96, resetsAt: "2026-11-02T00:00:00Z", status: "allowed" },
      },
    },
  }), "2026-10-30T12:00:00.000Z");

  assert.deepEqual(parsed?.windows, [
    { key: "five_hour", label: "5시간", remainingPercent: 75, resetsAt: 1_793_372_400 },
    { key: "seven_day", label: "주간", remainingPercent: 4, resetsAt: 1_793_577_600 },
  ]);
  assert.equal(parsed?.source, "claude-stream");
});

test("unknown Grok stream fields never fabricate quota windows", () => {
  assert.equal(parseProviderQuota("grok", JSON.stringify({ usage: { inputTokens: 42 }, remaining: 99 })), undefined);
});

test("Claude single-window events keep their real rate limit label", () => {
  const weekly = parseProviderQuota("claude", JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { rateLimitType: "seven_day", utilization: 0.5, resetsAt: "2026-11-02T00:00:00Z" },
  }));
  assert.deepEqual(weekly?.windows.map(({ key, label, remainingPercent }) => ({ key, label, remainingPercent })), [
    { key: "seven_day", label: "주간", remainingPercent: 50 },
  ]);
});

test("latest provider state is persisted while Codex session scan selects the newest rate limit event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-quota-"));
  const home = join(directory, "home");
  const sessions = join(home, ".codex", "sessions", "2026", "10");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "old.jsonl"), JSON.stringify({ timestamp: "2026-10-29T10:00:00Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 90, window_minutes: 300 } } } }) + "\n");
  await writeFile(join(sessions, "new.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-30T11:00:00Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 60, window_minutes: 300 } } } }),
    JSON.stringify({ timestamp: "2026-10-30T12:00:00Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } }),
  ].join("\n") + "\n");
  await saveProviderQuota({ agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 55 }], updatedAt: "2026-10-30T09:00:00Z", source: "claude-stream" }, directory);

  assert.equal((await scanCodexQuota(home))?.windows[0]?.remainingPercent, 80);
  const providers = await loadProviderQuotas(directory, home);
  assert.equal(providers.find((item) => item.agent === "claude")?.windows[0]?.remainingPercent, 55);
  assert.equal(providers.find((item) => item.agent === "codex")?.windows[0]?.remainingPercent, 80);
  assert.equal(providers.find((item) => item.agent === "grok")?.unavailableReason, "남은 한도 정보 제공 안 함");
});

test("Codex scan uses event timestamps when a copied stale file has the newest mtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-quota-mtime-"));
  const sessions = join(directory, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const current = join(sessions, "current.jsonl");
  const copied = join(sessions, "copied-old.jsonl");
  await writeFile(current, JSON.stringify({ timestamp: "2026-10-30T12:00:00Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } }) + "\n");
  await writeFile(copied, JSON.stringify({ timestamp: "2026-10-30T10:00:00Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 70, window_minutes: 300 } } } }) + "\n");
  await utimes(current, new Date("2026-10-30T12:00:00Z"), new Date("2026-10-30T12:00:00Z"));
  await utimes(copied, new Date("2026-10-30T13:00:00Z"), new Date("2026-10-30T13:00:00Z"));

  const quota = await scanCodexQuota(directory);
  assert.equal(quota?.updatedAt, "2026-10-30T12:00:00Z");
  assert.equal(quota?.windows[0]?.remainingPercent, 80);
});

test("malformed cached provider entries and windows are discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-quota-invalid-"));
  await writeFile(join(directory, "provider-limits.json"), JSON.stringify([
    { agent: "invalid", windows: [] },
    { agent: "claude", windows: [{ key: "bad", label: "bad", remainingPercent: "many" }, { key: "five_hour", label: "5시간", remainingPercent: 25 }] },
  ]));
  const providers = await loadProviderQuotas(directory, directory);
  assert.equal(providers.some((provider) => (provider.agent as string) === "invalid"), false);
  assert.deepEqual(providers.find((provider) => provider.agent === "claude")?.windows, [{ key: "five_hour", label: "5시간", remainingPercent: 25 }]);
});

test("automatic routing excludes fresh providers below ten percent when another agent is usable", () => {
  const quotas = [
    { agent: "codex" as const, windows: [{ key: "weekly", label: "주간", remainingPercent: 9 }], updatedAt: "2026-10-30T11:00:00Z" },
    { agent: "claude" as const, windows: [{ key: "weekly", label: "주간", remainingPercent: 40 }], updatedAt: "2026-10-30T11:00:00Z" },
  ];
  assert.deepEqual(quotaEligibleAgents(["codex", "claude", "grok"], quotas, new Date("2026-10-30T12:00:00Z")), ["claude", "grok"]);
  assert.deepEqual(quotaEligibleAgents(["codex"], quotas, new Date("2026-10-30T12:00:00Z")), ["codex"]);
  assert.deepEqual(quotaEligibleAgents(["codex", "claude"], quotas, new Date("2026-11-02T12:00:00Z")), ["codex", "claude"], "stale quota must not block routing");
  const reset = [{ ...quotas[0], windows: [{ ...quotas[0].windows[0], resetsAt: 1_793_360_000 }] }];
  assert.deepEqual(quotaEligibleAgents(["codex", "claude"], reset, new Date("2026-10-30T12:00:00Z")), ["codex", "claude"], "a passed reset must not keep deprioritizing an agent");
});
