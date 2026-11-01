import assert from "node:assert/strict";
import test from "node:test";
import type { PlannerRunner } from "./routing.js";
import { createQuotaFallbackRunner, type RouterFallbackContext } from "./router-fallback.js";

function context(overrides: Partial<RouterFallbackContext> = {}): RouterFallbackContext {
  return {
    enabled: true,
    threshold: 3,
    allowedAgents: ["codex", "claude", "grok"],
    authenticatedAgents: ["codex", "claude", "grok"],
    quotas: [
      { agent: "codex", windows: [{ key: "primary", label: "5시간", remainingPercent: 0, resetsAt: 1_800_000_000 }] },
      { agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 75 }] },
      { agent: "grok", windows: [{ key: "current", label: "현재", remainingPercent: 45 }] },
    ],
    ...overrides,
  };
}

test("router runner proactively uses the best authenticated fallback with an equivalent model tier", async () => {
  const calls: Array<{ agent: string; model?: string; prompt: string }> = [];
  const runner: PlannerRunner = async (options) => {
    calls.push({ agent: options.agent, model: options.model, prompt: options.prompt });
    return { exitCode: 0, finalText: "ok" };
  };
  const wrapped = createQuotaFallbackRunner(runner, async () => context());

  const result = await wrapped({
    agent: "codex", model: "gpt-5.4", reasoningEffort: "high", prompt: "분류해줘", cwd: process.cwd(),
    usageContext: { workspaceId: "personal", sessionId: "router-task", role: "router" }, onLine: () => undefined,
  });

  assert.equal(result.finalText, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.agent, "claude");
  assert.match(calls[0]?.model ?? "", /opus|sonnet/i);
  assert.match(calls[0]?.prompt ?? "", /Codex.*한도.*Claude/s);
});

test("router runner retries one failed quota-limited run with the partial log in its handoff", async () => {
  const calls: Array<{ agent: string; prompt: string }> = [];
  const runner: PlannerRunner = async (options) => {
    calls.push({ agent: options.agent, prompt: options.prompt });
    if (calls.length === 1) {
      options.onLine({ type: "message", text: "입력 분석 완료" });
      options.onLine({ type: "error", text: "429 rate_limit quota exceeded" });
      return { exitCode: 1, finalText: "" };
    }
    return { exitCode: 0, finalText: "fallback-ok" };
  };
  const wrapped = createQuotaFallbackRunner(runner, () => context({
    quotas: [{ agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 75 }] }],
  }));

  const result = await wrapped({ agent: "codex", prompt: "분류해줘", cwd: process.cwd(), onLine: () => undefined });

  assert.equal(result.finalText, "fallback-ok");
  assert.deepEqual(calls.map((call) => call.agent), ["codex", "claude"]);
  assert.match(calls[1]?.prompt ?? "", /분류해줘/);
  assert.match(calls[1]?.prompt ?? "", /입력 분석 완료/);
  assert.match(calls[1]?.prompt ?? "", /429 rate_limit/);
});

test("router runner retries a normalized quota error even when the CLI exits zero", async () => {
  const agents: string[] = [];
  const runner: PlannerRunner = async (options) => {
    agents.push(options.agent);
    if (agents.length === 1) {
      options.onLine({ type: "error", text: "usage limit reached" });
      return { exitCode: 0, finalText: "" };
    }
    return { exitCode: 0, finalText: "recovered" };
  };
  const wrapped = createQuotaFallbackRunner(runner, () => context({ quotas: [] }));

  const result = await wrapped({ agent: "codex", prompt: "분류", cwd: process.cwd(), onLine: () => undefined });
  assert.equal(result.finalText, "recovered");
  assert.deepEqual(agents, ["codex", "claude"]);
});

test("router runner reports a bounded diagnostic and continues when fallback context fails", async () => {
  const lines: string[] = [];
  let calls = 0;
  const runner: PlannerRunner = async () => { calls += 1; return { exitCode: 0, finalText: "ok" }; };
  const wrapped = createQuotaFallbackRunner(runner, async () => { throw new Error("secret resolver internals"); });

  const result = await wrapped({ agent: "codex", prompt: "분류", cwd: process.cwd(), onLine: (line) => lines.push(`${line.type}:${line.text}`) });
  assert.equal(result.finalText, "ok");
  assert.equal(calls, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^status:.*자동 전환/);
  assert.doesNotMatch(lines[0] ?? "", /secret resolver internals/);
});

test("router runner does not retry ordinary failures, disabled fallback, or aborted work", async () => {
  for (const scenario of ["ordinary", "disabled", "aborted"] as const) {
    let calls = 0;
    const runner: PlannerRunner = async () => {
      calls += 1;
      if (scenario === "aborted") throw new Error("usage limit reached");
      return { exitCode: 1, finalText: scenario === "ordinary" ? "invalid JSON" : "usage limit reached" };
    };
    const controller = new AbortController();
    if (scenario === "aborted") controller.abort();
    const wrapped = createQuotaFallbackRunner(runner, () => context({ enabled: scenario !== "disabled", quotas: [] }));
    if (scenario === "aborted") await assert.rejects(() => wrapped({ agent: "codex", prompt: "x", cwd: process.cwd(), signal: controller.signal, onLine: () => undefined }), /usage limit/);
    else await wrapped({ agent: "codex", prompt: "x", cwd: process.cwd(), onLine: () => undefined });
    assert.equal(calls, 1, scenario);
  }
});

test("router fallback never selects an agent the workspace does not allow, even with the most quota", async () => {
  const agents: string[] = [];
  const runner: PlannerRunner = async (options) => {
    agents.push(options.agent);
    return { exitCode: 0, finalText: "ok" };
  };
  const wrapped = createQuotaFallbackRunner(runner, () => context({
    allowedAgents: ["claude", "grok"],
    quotas: [
      { agent: "claude", windows: [{ key: "current", label: "현재", remainingPercent: 0 }] },
      { agent: "codex", windows: [{ key: "current", label: "현재", remainingPercent: 99 }] },
      { agent: "grok", windows: [{ key: "current", label: "현재", remainingPercent: 20 }] },
    ],
  }));

  await wrapped({
    agent: "claude", prompt: "분류", cwd: process.cwd(), onLine: () => undefined,
    usageContext: { workspaceId: "company", sessionId: "company-router", role: "router" },
  });
  assert.deepEqual(agents, ["grok"]);
});

test("router runner keeps the requested agent when no authenticated fallback is usable", async () => {
  const agents: string[] = [];
  const runner: PlannerRunner = async (options) => {
    agents.push(options.agent);
    return { exitCode: 1, finalText: "usage limit reached" };
  };
  const wrapped = createQuotaFallbackRunner(runner, () => context({
    authenticatedAgents: ["codex"],
    quotas: [{ agent: "codex", windows: [{ key: "primary", label: "5시간", remainingPercent: 0 }] }],
  }));

  const result = await wrapped({ agent: "codex", prompt: "분류", cwd: process.cwd(), onLine: () => undefined });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(agents, ["codex"]);
});

test("media pair fallback works from Grok to Codex and Codex to Grok", async () => {
  for (const [primary, secondary] of [["grok", "codex"], ["codex", "grok"]] as const) {
    const agents: string[] = [];
    const runner: PlannerRunner = async (options) => {
      agents.push(options.agent);
      return { exitCode: 0, finalText: "ok" };
    };
    const wrapped = createQuotaFallbackRunner(runner, () => context({
      authenticatedAgents: [primary, secondary],
      allowedAgents: [primary, secondary],
      quotas: [
        { agent: primary, windows: [{ key: "current", label: "현재", remainingPercent: 0 }] },
        { agent: secondary, windows: [{ key: "current", label: "현재", remainingPercent: 50 }] },
      ],
    }));
    await wrapped({ agent: primary, prompt: "미디어 생성", cwd: process.cwd(), onLine: () => undefined });
    assert.deepEqual(agents, [secondary]);
  }
});
