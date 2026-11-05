import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildInvocation, type RunCliOptions } from "./cli.js";
import { codexLeadArgs, LEAD_MCP_RULE, LEAD_MCP_SERVER, leadServerScript, type LeadMcpLaunch } from "./lead-tools.js";
import { handleToolMcp, toolsFor } from "./app-tools.js";
import { Orchestra } from "./orchestra.js";
import { permissionMcpConfig } from "./permission-prompts.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();

async function waitFor(predicate: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-lead-tools-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "README.md"), "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, dataDir: join(base, "data") };
}

const launch: LeadMcpLaunch = { command: "/usr/bin/node", script: "/data/hooks/sinawi-lead.mjs", token: "tok", port: "3999" };
const base = { prompt: "p", cwd: "/work" } as const;
const flagValues = (args: string[], flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);

const handleLeadMcp = (message: object, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => handleToolMcp(message, "lead", LEAD_MCP_SERVER, call);

test("the MCP handler answers initialize, tools/list and tools/call, and reports tool errors to the lead", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === "schedule_update") throw new Error("일정을 찾을 수 없습니다");
    return { ok: true };
  };
  const init = await handleLeadMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, call) as any;
  assert.equal(init.result.serverInfo.name, LEAD_MCP_SERVER);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  const list = await handleLeadMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call) as any;
  const names = list.result.tools.map((tool: { name: string }) => tool.name);
  for (const name of ["delegate_task", "check_task", "collect_results", "write_skill", "update_skill", "schedule_create", "schedule_list", "schedule_update", "schedule_delete"]) assert.ok(names.includes(name), name);
  assert.ok(toolsFor("lead").every((tool) => tool.inputSchema.type === "object"));
  const ok = await handleLeadMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_task", arguments: { task_id: "t1" } } }, call) as any;
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { ok: true });
  assert.deepEqual(calls[0], ["check_task", { task_id: "t1" }]);
  const failed = await handleLeadMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "schedule_update", arguments: { id: "x" } } }, call) as any;
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /찾을 수 없습니다/u);
  const unknown = await handleLeadMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } }, call) as any;
  assert.equal(unknown.error.code, -32602);
  assert.equal((await handleLeadMcp({ jsonrpc: "2.0", id: 6, method: "resources/list" }, call) as any).error.code, -32601);
  assert.equal(await handleLeadMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, call), undefined, "notifications get no answer");
  assert.match(leadServerScript(), /\/api\/lead-mcp/u);
  assert.match(leadServerScript(), /x-sinawi-token/u);
});

test("Claude gets the lead tools in one --mcp-config with the permission server, and allows them", () => {
  const permission = permissionMcpConfig("/data/hooks/sinawi-permission.mjs", "tok", "/usr/bin/node");
  const { args } = buildInvocation({ ...base, agent: "claude", permissionMcp: permission, leadMcp: launch });
  const configs = flagValues(args, "--mcp-config");
  assert.equal(configs.length, 1, "a single --mcp-config");
  const servers = JSON.parse(configs[0]).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["sinawi_lead", "sinawi_permission"].sort());
  assert.deepEqual(servers.sinawi_lead, { type: "stdio", command: "/usr/bin/node", args: ["/data/hooks/sinawi-lead.mjs"], env: { SINAWI_COMPUTER_TOKEN: "tok", SINAWI_PORT: "3999" } });
  assert.ok(flagValues(args, "--allowedTools").includes(LEAD_MCP_RULE));
  assert.ok(args.includes("--permission-prompt-tool"));
  assert.ok(!args.includes("--strict-mcp-config"), "the user's own MCP servers still load");

  const full = buildInvocation({ ...base, agent: "claude", fullAccess: true, leadMcp: launch }).args;
  assert.deepEqual(Object.keys(JSON.parse(flagValues(full, "--mcp-config")[0]).mcpServers), ["sinawi_lead"]);
  assert.ok(!full.includes("--permission-prompt-tool"));

  const review = buildInvocation({ ...base, agent: "claude", readOnly: true, readTools: true, leadMcp: launch }).args;
  assert.ok(!review.join(" ").includes("sinawi_lead"), "read-only runs (reviews) get no lead tools");
  const plain = buildInvocation({ ...base, agent: "claude" }).args;
  assert.ok(!plain.includes("--mcp-config"), "no lead tools unless asked");
});

test("Codex gets the lead tools as -c mcp_servers overrides; Grok has no per-run MCP and keeps the tags", () => {
  const { args } = buildInvocation({ ...base, agent: "codex", leadMcp: launch });
  const overrides = flagValues(args, "-c");
  assert.ok(overrides.includes('mcp_servers.sinawi_lead.command="/usr/bin/node"'));
  assert.ok(overrides.includes('mcp_servers.sinawi_lead.args=["/data/hooks/sinawi-lead.mjs"]'));
  assert.ok(overrides.includes('mcp_servers.sinawi_lead.env={SINAWI_COMPUTER_TOKEN="tok",SINAWI_PORT="3999"}'));
  assert.ok(overrides.some((item) => /^mcp_servers\.sinawi_lead\.tool_timeout_sec=\d+$/u.test(item)));
  assert.deepEqual(codexLeadArgs(launch).filter((_, index) => index % 2 === 0).every((flag) => flag === "-c"), true);
  assert.equal(args.at(-1), "p", "the prompt stays last");
  assert.ok(!buildInvocation({ ...base, agent: "codex", readOnly: true, leadMcp: launch }).args.join(" ").includes("sinawi_lead"));
  const grok = buildInvocation({ ...base, agent: "grok", leadMcp: launch }).args;
  assert.ok(!grok.join(" ").includes("sinawi_lead"));
});

test("a lead's run asks for its tools; workers and reviews do not; the prompt explains them", async (t) => {
  const { repo, dataDir } = await setup(t);
  const seen: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    seen.push(options);
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 진행\n했습니다" };
    if (options.readOnly) return { exitCode: 0, finalText: "검토했습니다" };
    return { exitCode: 0, finalText: "<<DELEGATE to=\"claude\">>파일 보기<</DELEGATE>>" };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "일", agent: "claude", workers: ["claude"], cwd: repo, steward: { name: "api" } });
  await waitFor(() => chat.status === "done");
  const lead = seen.find((options) => options.usageContext?.role === "orchestrator" && !options.readOnly)!;
  assert.equal(lead.leadTools, true);
  assert.match(lead.prompt, /## 담당 도구/u);
  assert.ok(seen.filter((options) => options.usageContext?.role === "worker").every((options) => !options.leadTools));
  assert.ok(seen.filter((options) => options.readOnly).every((options) => !options.leadTools));

  // A plain chat (not a lead) never gets them.
  seen.length = 0;
  const plain = await orchestra.create({ prompt: "일", agent: "claude", workers: ["claude"], cwd: repo });
  await waitFor(() => plain.status === "done");
  assert.ok(seen.every((options) => !options.leadTools));
});

test("delegate_task runs briefs in parallel, two of the same CLI at once, and collect_results waits for them", async (t) => {
  const { repo, dataDir } = await setup(t);
  let running = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const workerRuns: RunCliOptions[] = [];
  let collected: any;
  let chatId = "";
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerRuns.push(options);
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      return { exitCode: 0, finalText: `상태: 완료\n${options.prompt.includes("화면 만들기") ? "화면" : "API"} 끝` };
    }
    if (options.readOnly) return { exitCode: 0, finalText: "검토 끝" };
    const [first, second] = await Promise.all([
      orchestra.leadToolCall(chatId, "delegate_task", { agent: "codex", brief: "API 만들기", group: "g" }),
      orchestra.leadToolCall(chatId, "delegate_task", { agent: "codex", brief: "화면 만들기", group: "g", kind: "design" }),
    ]) as any[];
    assert.notEqual(first.worker, second.worker, "the second Codex brief gets its own worker");
    await waitFor(() => running === 2);
    const status = await orchestra.leadToolCall(chatId, "check_task", {}) as any;
    assert.deepEqual(status.tasks.map((task: { status: string }) => task.status), ["running", "running"]);
    const pending = orchestra.leadToolCall(chatId, "collect_results", { group: "g", wait: true });
    for (const done of release.splice(0)) done();
    collected = await pending;
    return { exitCode: 0, finalText: "둘 다 끝냈습니다." };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "API와 화면", agent: "claude", workers: ["codex"], cwd: repo, steward: { name: "web" } });
  chatId = chat.id;
  await waitFor(() => chat.status === "done");
  assert.equal(peak, 2, "both Codex briefs ran at the same time");
  assert.deepEqual(chat.workers, ["codex", "codex"], "a second Codex worker joined the team");
  assert.equal(new Set(workerRuns.map((options) => options.usageContext?.workerId)).size, 2);
  assert.equal(collected.results.length, 2);
  assert.ok(collected.results.every((item: { status: string }) => item.status === "done"));
  assert.match(collected.results.map((item: { result: string }) => item.result).join("\n"), /API 끝[\s\S]*화면 끝|화면 끝[\s\S]*API 끝/u);
  const design = workerRuns.find((options) => options.prompt.includes("화면 만들기"))!;
  assert.match(design.prompt, /## 디자인 작업/u, "a design brief asks for screenshots in the report");
  assert.ok(chat.events.filter((event) => event.type === "delegation").length >= 2, "each brief shows as a delegation card");
  assert.ok(!chat.events.some((event) => event.text.includes("검토 끝")), "everything was collected: no extra review run");
});

test("delegate_task applies a requested model to an existing worker selected by ID", async (t) => {
  const { repo, dataDir } = await setup(t);
  let chatId = "";
  const workerModels: Array<string | undefined> = [];
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      workerModels.push(options.model);
      return { exitCode: 0, finalText: "상태: 완료\n끝" };
    }
    if (options.readOnly) return { exitCode: 0, finalText: "검토" };
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "기본 모델 검토" });
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", model: "sonnet", brief: "첫 지정 모델 검토" });
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", model: "haiku", brief: "둘째 지정 모델 검토" });
    await orchestra.leadToolCall(chatId, "collect_results", {});
    return { exitCode: 0, finalText: "끝" };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({
    prompt: "검토", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "model" },
    workerConfigs: [{ agent: "claude", model: "opus" }],
  });
  chatId = chat.id;
  await waitFor(() => chat.status === "done");
  assert.deepEqual(workerModels, ["opus", "sonnet", "haiku"], "each queued brief keeps its model at dispatch time");
  assert.equal(chat.workerConfigs?.[0].model, "haiku", "the latest selected model remains on the lead's team");
});

test("delegate_task refuses to auto-add a CLI that is not installed or logged in", async (t) => {
  for (const readiness of [
    { installed: false, authenticated: false, detail: "Claude CLI가 설치되어 있지 않습니다." },
    { installed: true, authenticated: false, detail: "Claude 로그인 필요: 터미널에서 claude auth login" },
  ]) {
    const { repo, dataDir } = await setup(t);
    let chatId = "";
    let failure = "";
    const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
      if (options.usageContext?.role === "orchestrator" && chatId) {
        await orchestra.leadToolCall(chatId, "delegate_task", { agent: "claude", brief: "검토" }).catch((error: Error) => { failure = error.message; });
      }
      return { exitCode: 0, finalText: "끝" };
    });
    orchestra.workerReadiness = async () => readiness;
    orchestra.stewardDataDir = dataDir;
    const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["codex"], cwd: repo, steward: { name: "ready" } });
    await waitFor(() => chat.status === "done");
    chatId = chat.id;
    await orchestra.followup(chat.id, "Claude에게 맡겨");
    await waitFor(() => chat.status === "done" && Boolean(failure));
    assert.match(failure, new RegExp(readiness.detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.deepEqual(chat.workers, ["codex"]);
    assert.ok(chat.events.some((event) => event.type === "warning" && event.text.includes(readiness.detail)));
  }
});

test("briefs the lead did not collect go to the review; a brief for one worker waits for that worker", async (t) => {
  const { repo, dataDir } = await setup(t);
  let reviewPrompt = "";
  let running = 0;
  let peak = 0;
  let chatId = "";
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return { exitCode: 0, finalText: `상태: 진행\n${options.prompt.includes("둘째 일") ? "둘째 결과" : "첫 결과"}` };
    }
    if (options.readOnly) { reviewPrompt = options.prompt; return { exitCode: 0, finalText: "검토했습니다" }; }
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "첫 일" });
    await orchestra.leadToolCall(chatId, "delegate_task", { worker: "claude", brief: "둘째 일" });
    return { exitCode: 0, finalText: "맡겼습니다" };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "두 일", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "one" } });
  chatId = chat.id;
  await waitFor(() => chat.status === "done");
  assert.equal(peak, 1, "one worker runs one brief at a time");
  assert.match(reviewPrompt, /첫 결과/u);
  assert.match(reviewPrompt, /둘째 결과/u);
  // The turn is over: its tools have nothing to act on.
  await assert.rejects(orchestra.leadToolCall(chat.id, "delegate_task", { brief: "늦은 일" }), /진행 중인 턴이 없어/u);
  await assert.rejects(orchestra.leadToolCall("nope", "check_task", {}), /담당 채팅이 아닙니다/u);
});

test("write_skill and update_skill keep reusable skills that delegate_task attaches to a brief", async (t) => {
  const { repo, dataDir } = await setup(t);
  let chatId = "";
  let workerPrompt = "";
  let listed: any;
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") { workerPrompt = options.prompt; return { exitCode: 0, finalText: "상태: 완료\n끝" }; }
    if (options.readOnly) return { exitCode: 0, finalText: "검토" };
    await orchestra.leadToolCall(chatId, "write_skill", { name: "API Review", description: "API 검토 순서", content: "1. 스키마부터 본다" });
    await assert.rejects(orchestra.leadToolCall(chatId, "write_skill", { name: "api-review", description: "d", content: "c" }), /이미 있습니다/u);
    await orchestra.leadToolCall(chatId, "update_skill", { name: "api-review", content: "1. 스키마부터 본다\n2. 테스트를 돌린다" });
    await orchestra.leadToolCall(chatId, "write_skill", { name: "shared", description: "모두 쓰는 규칙", content: "공용 규칙", scope: "project" });
    listed = await orchestra.leadToolCall(chatId, "list_skills", {});
    const task = await orchestra.leadToolCall(chatId, "delegate_task", { worker: "codex", brief: "API 검토", skills: ["api-review", "shared", "없는것"] }) as any;
    assert.deepEqual(task.missing_skills, ["없는것"]);
    await orchestra.leadToolCall(chatId, "collect_results", {});
    return { exitCode: 0, finalText: "검토 맡김" };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "검토", agent: "claude", workers: ["codex"], cwd: repo, steward: { name: "rev" } });
  chatId = chat.id;
  await waitFor(() => chat.status === "done");
  const stewardId = chat.steward!.id!;
  const file = await readFile(join(dataDir, "stewards", stewardId, "skills", "api-review", "SKILL.md"), "utf8");
  assert.match(file, /^---\nname: api-review\ndescription: API 검토 순서\n---/u);
  assert.match(file, /2\. 테스트를 돌린다/u);
  assert.match(await readFile(join(repo, ".claude", "skills", "shared", "SKILL.md"), "utf8"), /공용 규칙/u);
  assert.ok(listed.lead.some((item: { name: string }) => item.name === "api-review"));
  assert.match(workerPrompt, /--- api-review \(담당\) ---[\s\S]*테스트를 돌린다/u);
  assert.match(workerPrompt, /공용 규칙/u);
  assert.ok(chat.events.some((event) => event.metadata?.leadSkill?.name === "api-review" && event.metadata.leadSkill.action === "updated"));
});

test("a lead answering another lead without leave cannot hand out work through its tools either", async (t) => {
  const { repo, dataDir } = await setup(t);
  let chatId = "";
  let refused = "";
  const orchestra: Orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "orchestrator" && !options.readOnly && chatId) {
      await orchestra.leadToolCall(chatId, "delegate_task", { brief: "남의 일" }).catch((error: Error) => { refused = error.message; });
    }
    return { exitCode: 0, finalText: "답" };
  });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "claude", workers: ["codex"], cwd: repo, steward: { name: "a" } });
  await waitFor(() => chat.status === "done");
  chatId = chat.id;
  chat.steward!.answering = { id: "other", question: "q", depth: 0 };
  await orchestra.followup(chat.id, "다른 담당의 질문");
  await waitFor(() => chat.status === "done" && Boolean(refused));
  assert.match(refused, /다른 담당의 질문에 답하는 중/u);
});

test("a lead's chat started with only steward:{id} takes the lead's team, else the workspace's agents", async (t) => {
  const { repo, dataDir } = await setup(t);
  const leads: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "orchestrator" && !options.readOnly) leads.push(options);
    return { exitCode: 0, finalText: "네" };
  }, undefined, undefined, undefined, (workspaceId) => workspaceId === "narrow" ? ["codex", "grok"] : ["codex", "claude", "grok"]);
  orchestra.stewardDataDir = dataDir;
  const team = orchestra.createSteward({ name: "팀 있음", agent: "codex", workers: [{ agent: "claude", model: "sonnet" }], cwds: [repo] });
  const withTeam = await orchestra.create({ prompt: "안녕", steward: { id: team.id } } as never);
  await waitFor(() => withTeam.status === "done");
  assert.equal(withTeam.agent, "codex");
  assert.deepEqual(withTeam.workers, ["claude"]);
  assert.equal(withTeam.workerConfigs?.[0].model, "sonnet");
  assert.equal(withTeam.cwd, repo, "the lead's folder");

  const bare = orchestra.createSteward({ name: "팀 없음", agent: "codex", cwds: [repo] });
  orchestra.patchSteward(bare.id, { workers: [] });
  const noTeam = await orchestra.create({ prompt: "안녕", steward: { id: bare.id }, workspaceId: "narrow" } as never);
  await waitFor(() => noTeam.status === "done");
  assert.equal(noTeam.agent, "codex", "the lead's own CLI stays");
  assert.deepEqual(noTeam.workers, ["codex", "grok"], "one worker per allowed agent");
});
