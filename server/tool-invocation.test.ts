import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, prepareCliInvocation, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { mutateToolSettings, workspaceToolSettings } from "./store.js";
import { defaultWorkspacePolicy } from "./workspace-policy.js";
import { withWorkspaceMcpBlocks } from "./server.js";
import { RoutingService, defaultRoutingSettings } from "./routing.js";
import { recommendAutoSwitch } from "./auto-routing.js";
import { createQuotaFallbackRunner } from "./router-fallback.js";

test("Claude app-level MCP blocks are passed to both fresh and resumed CLI invocations", async () => {
  const invocation = await prepareCliInvocation({ agent: "claude", cwd: "/tmp", prompt: "work", resumeSessionId: "prior", blockedMcp: ["mcp__example__*"] });
  const denied = invocation.args.flatMap((arg, index) => invocation.args[index - 1] === "--disallowedTools" ? [arg] : []);
  assert.deepEqual(denied, ["mcp__example__*"]);
  assert.ok(invocation.args.includes("--resume"));
  const plain = buildInvocation({ agent: "claude", cwd: "/tmp", prompt: "work" }).args;
  assert.equal(plain.includes("--disallowedTools"), false);
});

test("Orchestra applies workspace app-level MCP blocks at the runner boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-invocation-"));
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledMcp = ["claude:example"]; }, cwd);
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "complete" };
  }, undefined, undefined, undefined, undefined, cwd);
  for (const workspaceId of ["personal", "company"] as const) {
    const session = await orchestra.create({ prompt: "Review code", agent: "claude", workers: ["grok"], cwd, workspaceId });
    const deadline = Date.now() + 3000;
    while (session.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(session.status, "done");
  }
  assert.deepEqual(calls[0].blockedMcp, ["mcp__example__*"]);
  assert.deepEqual(calls[1].blockedMcp, []);
});

test("route and automatic-switch planners receive workspace MCP blocks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-router-"));
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledMcp = ["codex:route-tool"]; }, cwd);
  const calls: RunCliOptions[] = [];
  const runner = withWorkspaceMcpBlocks(async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: JSON.stringify({
      planner: { agent: "codex", reason: "plan" }, orchestrator: { agent: "codex", reason: "work" },
      workers: [{ agent: "claude", reason: "review" }], skills: [], reason: "route",
    }) };
  }, cwd);
  const service = new RoutingService({ dataDir: cwd, runner, skillLoader: async () => [] });
  const settings = structuredClone(defaultRoutingSettings);
  settings.planner.agent = "codex";
  settings.modelOptions.codex.authStatus = "authenticated";
  settings.modelOptions.claude.authStatus = "authenticated";
  await service.saveSettings(settings);
  await service.recommend("설계와 구현", cwd, [], ["codex", "claude"], { workspaceId: "personal", sessionId: "route", role: "router", dataDir: cwd });
  await recommendAutoSwitch("설계와 구현", cwd, await service.loadSettings(), ["codex", "claude"], runner, undefined,
    { workspaceId: "personal", sessionId: "switch", role: "router", dataDir: cwd });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.agent === "codex"));
  assert.ok(calls.every((call) => call.blockedMcp?.includes("mcp__route-tool__*")));
});

test("quota fallback derives MCP blocks from the fallback agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-router-fallback-"));
  await mutateToolSettings((settings) => { workspaceToolSettings(settings, "personal").disabledMcp = ["codex:first", "claude:fallback"]; }, cwd);
  const calls: RunCliOptions[] = [];
  const protectedRunner = withWorkspaceMcpBlocks(async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  }, cwd);
  const runner = createQuotaFallbackRunner(protectedRunner, async () => ({
    enabled: true, threshold: 3, allowedAgents: ["codex", "claude"], authenticatedAgents: ["codex", "claude"],
    quotas: [{ agent: "codex", updatedAt: new Date().toISOString(), windows: [{ key: "weekly", label: "주간", remainingPercent: 0 }] }],
  }));
  await runner({ agent: "codex", cwd, prompt: "route", readOnly: true, onLine: () => undefined,
    usageContext: { workspaceId: "personal", sessionId: "fallback", role: "router", dataDir: cwd } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, "claude");
  assert.deepEqual(calls[0].blockedMcp, ["mcp__fallback__*"]);
});

test("workspace MCP blocks override Codex native state and reach Grok deny flags", async () => {
  const codex = await prepareCliInvocation({ agent: "codex", cwd: "/tmp", prompt: "work", blockedMcp: ["mcp__docs.local__*"] });
  const index = codex.args.indexOf("-c");
  assert.equal(codex.args[index + 1], 'mcp_servers."docs.local".enabled=false');
  const grok = await prepareCliInvocation({ agent: "grok", cwd: "/tmp", prompt: "work", blockedMcp: ["mcp__docs__*"] });
  assert.equal(grok.args[grok.args.indexOf("--deny") + 1], "mcp__docs__*");
});

test("workspace-locked tools and the Grok MCP switch reach orchestra and planner runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-policy-"));
  const policy = { ...defaultWorkspacePolicy(), grokMcp: false, blockedTools: ["media-tool", "claude:docs"] };
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "complete" };
  }, undefined, undefined, undefined, undefined, cwd, undefined, undefined, undefined, (id) => id === "team" ? policy : defaultWorkspacePolicy());
  const session = await orchestra.create({ prompt: "Review code", agent: "claude", workers: ["grok"], cwd, workspaceId: "team" });
  const deadline = Date.now() + 3000;
  while (session.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const claude = calls.find((call) => call.agent === "claude")!;
  assert.deepEqual(claude.lockedMcp, ["media-tool", "docs"]);
  assert.deepEqual(claude.blockedMcp, ["mcp__media-tool__*", "mcp__docs__*"]);

  const planned: RunCliOptions[] = [];
  const runner = withWorkspaceMcpBlocks(async (options) => { planned.push(options); return { exitCode: 0, finalText: "" }; }, cwd, (id) => id === "team" ? policy : defaultWorkspacePolicy());
  await runner({ agent: "grok", cwd, prompt: "route", readOnly: true, onLine: () => undefined, usageContext: { workspaceId: "team", sessionId: "p", role: "router" } });
  await runner({ agent: "grok", cwd, prompt: "route", readOnly: true, onLine: () => undefined, usageContext: { workspaceId: "other", sessionId: "q", role: "router" } });
  assert.deepEqual(planned[0].lockedMcp, ["media-tool"]);
  assert.deepEqual(planned[0].blockedMcp, ["mcp__media-tool__*", "mcp__*"]);
  assert.equal(planned[1].lockedMcp, undefined);
  assert.deepEqual(planned[1].blockedMcp, []);
});
