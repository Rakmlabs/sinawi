import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestra, parseDelegations } from "./orchestra.js";
import { defaultWorkspacePolicy, mediaBlockedMessage } from "./workspace-policy.js";
import type { RunCliOptions } from "./cli.js";
import { publicSkills } from "./skills.js";

// No workspace id is special. These tests configure "company" the way an old install's migration does:
// Codex off and media generation off, through the same resolvers the server passes.
const restrictedAgents = (id: string) => id === "company" ? ["claude", "grok"] as const : ["codex", "claude", "grok"] as const;
const restrictedPolicy = (id: string) => ({ ...defaultWorkspacePolicy(), mediaGeneration: id !== "company" });
const codexBlocked = /작업 공간 설정에서 Codex 사용이 꺼져 있습니다/;

test("parseDelegations accepts supported agents and ignores empty tasks", () => {
  assert.deepEqual(parseDelegations('<<DELEGATE to="claude">>Review API<</DELEGATE>><<DELEGATE to="grok">>  <</DELEGATE>>'), [
    { target: "claude", task: "Review API" },
  ]);
});

test("orchestrator runs selected worker and sends its result back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const calls: Array<{ agent: string; prompt: string; resumeSessionId?: string }> = [];
  const runner = async (options: RunCliOptions) => {
    calls.push({ agent: options.agent, prompt: options.prompt, resumeSessionId: options.resumeSessionId });
    if (calls.length === 1) {
      const text = '<<DELEGATE to="claude">>Inspect tests<</DELEGATE>>';
      options.onLine({ type: "message", text, finalText: text, sessionId: "root-session" });
      return { exitCode: 0, finalText: text, sessionId: "root-session" };
    }
    if (options.agent === "claude") {
      options.onLine({ type: "message", text: "Tests pass", finalText: "Tests pass" });
      return { exitCode: 0, finalText: "Tests pass" };
    }
    options.onLine({ type: "message", text: "Final answer", finalText: "Final answer" });
    return { exitCode: 0, finalText: "Final answer", sessionId: "root-session" };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "Do work", agent: "codex", workers: ["claude"], cwd });

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("session timeout")), 5_000);
    const poll = () => {
      if (session.status !== "running") { clearTimeout(deadline); resolve(); }
      else setTimeout(poll, 5);
    };
    poll();
  });
  assert.equal(session.status, "done");
  assert.deepEqual(calls.map((call) => call.agent), ["codex", "claude", "codex"]);
  assert.equal(calls[2].resumeSessionId, undefined);
  assert.match(calls[2].prompt, /Tests pass/);
  assert.match(calls[2].prompt, /\[P0\]/);
  assert.equal(session.cliSessionId, "root-session");
  assert.equal(session.events.some((event) => event.type === "delegation"), true);
  const delegation = session.events.find((event) => event.type === "delegation" && event.taskStatus === "running");
  assert.ok(delegation);
  assert.equal(delegation.delegationId, delegation.id);
  assert.equal(session.events.some((event) => event.type === "status" && event.delegationId === delegation.id && event.taskStatus === "done"), true);
  assert.equal(session.events.some((event) => event.role === "worker" && event.agent === "claude" && event.type === "message"), true);
});

test("same-agent workers keep distinct labels, logs, and resume sessions", async () => {
  const calls: Array<{ role?: string; model?: string; resumeSessionId?: string }> = [];
  const runner = async (options: RunCliOptions) => {
    calls.push({ role: options.usageContext?.role, model: options.model, resumeSessionId: options.resumeSessionId });
    if (options.usageContext?.role === "worker") {
      const sessionId = `${options.model}-session`;
      options.onLine({ type: "message", text: `${options.model} result`, finalText: `${options.model} result`, sessionId });
      return { exitCode: 0, finalText: `${options.model} result`, sessionId };
    }
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "final" };
    return { exitCode: 0, finalText: '<<DELEGATE to="codex-1">>first<</DELEGATE>><<DELEGATE to="codex-2">>second<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({
    prompt: "work", agent: "codex", workers: ["codex", "codex"], cwd: process.cwd(),
    workerConfigs: [{ agent: "codex", model: "model-a" }, { agent: "codex", model: "model-b" }],
  });
  await waitUntilSettled(session);
  assert.deepEqual(session.workerConfigs?.map(({ id, label }) => ({ id, label })), [
    { id: "codex-1", label: "Codex 1" }, { id: "codex-2", label: "Codex 2" },
  ]);
  assert.deepEqual(session.workerSessionIds, { "codex-1": "model-a-session", "codex-2": "model-b-session" });
  assert.deepEqual(session.events.filter((event) => event.type === "delegation").map((event) => event.workerId), ["codex-1", "codex-2"]);
  await orchestra.followup(session.id, "again");
  await waitUntilSettled(session);
  const workers = calls.filter((call) => call.role === "worker");
  assert.deepEqual(workers.slice(-2).map((call) => call.resumeSessionId), ["model-a-session", "model-b-session"]);
});

test("orchestrator does not run unselected delegated workers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  let calls = 0;
  const runner = async (options: RunCliOptions) => {
    calls += 1;
    const text = '<<DELEGATE to="grok">>Do something<</DELEGATE>>';
    options.onLine({ type: "message", text, finalText: text });
    return { exitCode: 0, finalText: text };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "Do work", agent: "codex", workers: ["claude"], cwd });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.status, "done");
  assert.equal(calls, 1);
});

test("follow-up preserves system prompt, workers, and CLI resume id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const calls: Array<{ agent: string; prompt: string; resumeSessionId?: string }> = [];
  const runner = async (options: RunCliOptions) => {
    calls.push({ agent: options.agent, prompt: options.prompt, resumeSessionId: options.resumeSessionId });
    if (calls.length === 1) return { exitCode: 0, finalText: "Initial", sessionId: "resume-me" };
    if (calls.length === 2) {
      const text = '<<DELEGATE to="claude">>Check follow-up<</DELEGATE>>';
      return { exitCode: 0, finalText: text, sessionId: "resume-me" };
    }
    if (options.agent === "claude") return { exitCode: 0, finalText: "Worker follow-up" };
    return { exitCode: 0, finalText: "Synthesized", sessionId: "resume-me" };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "First", agent: "codex", workers: ["claude"], cwd, systemPrompt: "ALWAYS PRECISE" });
  await waitUntilSettled(session);
  await orchestra.followup(session.id, "Second");
  await waitUntilSettled(session);

  assert.deepEqual(calls.map((call) => call.agent), ["codex", "codex", "claude", "codex"]);
  assert.match(calls[1].prompt, /ALWAYS PRECISE/);
  assert.equal(calls[1].resumeSessionId, "resume-me");
  assert.equal(session.events.filter((event) => event.agent === "user").length, 2);
});

test("manual new sessions automatically attach marketing-shorts for shorts requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-media-skill-"));
  const skillDirectory = join(cwd, ".agents", "skills", "marketing-shorts");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: marketing-shorts\ndescription: short video production\n---\nMARKETING-SHORTS-CONTENT\n");
  const prompts: string[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    prompts.push(options.prompt);
    return { exitCode: 0, finalText: "done" };
  });

  const session = await orchestra.create({ prompt: "쇼츠 만들어줘", agent: "grok", workers: ["grok"], cwd, mode: "manual" });
  await waitUntilSettled(session);

  assert.match(prompts[0], /MARKETING-SHORTS-CONTENT/);
  assert.ok(session.skills?.length);
});

test("manual media sessions keep the chosen team; auto sessions move the lead to Grok 4.7", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  });

  const manual = await orchestra.create({
    prompt: "광고 영상을 만들어줘", agent: "claude", model: "opus", workers: ["codex"], cwd: process.cwd(), mode: "manual", resumeSessionId: "claude-thread",
  });
  await waitUntilSettled(manual);
  assert.equal(manual.agent, "claude");
  assert.equal(manual.model, "opus");
  assert.deepEqual(manual.workers, ["codex"]);

  const auto = await orchestra.create({
    prompt: "광고 영상을 만들어줘", agent: "claude", model: "opus", workers: ["codex"], cwd: process.cwd(), mode: "auto", resumeSessionId: "claude-thread",
  });
  await waitUntilSettled(auto);
  assert.deepEqual(calls.map((call) => call.agent), ["claude", "grok"]);
  assert.equal(calls[1].resumeSessionId, undefined);
  assert.equal(auto.agent, "grok");
  assert.equal(auto.model, "grok-4.7");
  assert.deepEqual(auto.workers, ["codex"]);
});

test("with automatic switching off, media follow-ups keep the team the user picked", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  });
  const session = await orchestra.create({ prompt: "첫 요청", agent: "codex", workers: ["claude"], cwd: process.cwd(), mode: "auto", autoSwitch: false });
  await waitUntilSettled(session);

  await orchestra.followup(session.id, "썸네일 이미지를 만들어줘", [], { mode: "auto", autoSwitch: false });
  await waitUntilSettled(session);

  assert.deepEqual(calls.map((call) => call.agent), ["codex", "codex"]);
  assert.equal(session.agent, "codex");
  assert.deepEqual(session.workers, ["claude"]);
});

test("media requests warn without execution when the workspace prohibits Grok", async () => {
  const calls: RunCliOptions[] = [];
  const allowed = () => ["codex" as const, "claude" as const];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, allowed);

  await assert.rejects(
    orchestra.create({ prompt: "사진 편집해줘", agent: "claude", workers: ["claude"], cwd: process.cwd(), mode: "auto" }),
    /Grok 조정자를 사용할 수 없습니다/,
  );
  const session = await orchestra.create({ prompt: "첫 요청", agent: "claude", workers: ["claude"], cwd: process.cwd(), mode: "auto" });
  await waitUntilSettled(session);
  await orchestra.followup(session.id, "로고 시안을 만들어줘", [], { mode: "auto" });

  assert.equal(calls.length, 1);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Grok 조정자를 사용할 수 없습니다/);
});

test("follow-ups automatically attach marketing-shorts for reels requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-media-followup-"));
  const skillDirectory = join(cwd, ".agents", "skills", "marketing-shorts");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: marketing-shorts\ndescription: short video production\n---\nFOLLOWUP-SHORTS-CONTENT\n");
  const prompts: string[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    prompts.push(options.prompt);
    return { exitCode: 0, finalText: "done" };
  });
  const session = await orchestra.create({ prompt: "첫 요청", agent: "grok", workers: ["grok"], cwd, mode: "manual" });
  await waitUntilSettled(session);

  await orchestra.followup(session.id, "릴스 만들어줘", [], { mode: "manual" });
  await waitUntilSettled(session);

  assert.doesNotMatch(prompts[0], /FOLLOWUP-SHORTS-CONTENT/);
  assert.match(prompts[1], /FOLLOWUP-SHORTS-CONTENT/);
});

test("switching orchestrator starts a fresh CLI session with a concise conversation handoff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const calls: Array<Pick<RunCliOptions, "agent" | "prompt" | "model" | "reasoningEffort" | "resumeSessionId">> = [];
  const orchestra = new Orchestra(() => undefined, async (options) => {
    calls.push({ agent: options.agent, prompt: options.prompt, model: options.model, reasoningEffort: options.reasoningEffort, resumeSessionId: options.resumeSessionId });
    if (calls.length === 1) {
      options.onLine({ type: "message", text: "기존 오케스트라 답변", finalText: "기존 오케스트라 답변", sessionId: "old-cli" });
      return { exitCode: 0, finalText: "기존 오케스트라 답변", sessionId: "old-cli" };
    }
    return { exitCode: 0, finalText: "새 답변", sessionId: "new-cli" };
  });
  const session = await orchestra.create({ prompt: "첫 요청", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);

  orchestra.updateTeam(session.id, {
    agent: "claude", model: "sonnet", reasoningEffort: "high", workers: ["codex"],
    workerConfigs: [{ agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "low" }],
  });
  assert.equal(session.cliSessionId, undefined);
  assert.equal(session.events.at(-1)?.type, "handoff");
  assert.equal(session.events.at(-1)?.text, "오케스트라가 Codex → Claude로 바뀌었습니다");

  await orchestra.followup(session.id, "다음 요청");
  await waitUntilSettled(session);
  assert.equal(calls[1].agent, "claude");
  assert.equal(calls[1].model, "sonnet");
  assert.equal(calls[1].reasoningEffort, "high");
  assert.equal(calls[1].resumeSessionId, undefined);
  assert.match(calls[1].prompt, /이전 오케스트라의 대화 요약/);
  assert.match(calls[1].prompt, /사용자: 첫 요청/);
  assert.match(calls[1].prompt, /Codex: 기존 오케스트라 답변/);
  assert.equal(session.handoffContext, undefined);
});

test("team changes are rejected while a session is running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const orchestra = new Orchestra(() => undefined, () => new Promise(() => undefined));
  const session = await orchestra.create({ prompt: "진행 중", agent: "codex", workers: ["claude"], cwd });
  assert.throws(() => orchestra.updateTeam(session.id, { agent: "claude", workers: ["codex"] }), /실행 중에는 팀을 변경할 수 없습니다/);
  orchestra.stop(session.id);
});

test("changing a worker provider preserves its id but clears its provider-specific resume session", () => {
  const orchestra = new Orchestra();
  const session = {
    id: "provider-change", title: "provider change", agent: "codex" as const, workers: ["claude" as const],
    workerConfigs: [{ id: "reviewer", label: "Reviewer", agent: "claude" as const }],
    workerSessionIds: { reviewer: "claude-session" }, cwd: process.cwd(), status: "done" as const,
    createdAt: new Date().toISOString(), events: [], workspaceId: "personal" as const,
  };
  orchestra.restore([session]);
  orchestra.updateTeam(session.id, {
    agent: "codex", workers: ["grok"], workerConfigs: [{ id: "reviewer", label: "Reviewer", agent: "grok" }],
  });
  assert.equal(session.workerConfigs?.[0].id, "reviewer");
  assert.equal(session.workerSessionIds?.reviewer, undefined);
});

test("repeated connection and complete assistant events are deduplicated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const orchestra = new Orchestra(() => undefined, async (options) => {
    options.onLine({ type: "status", text: "CLI 세션 연결됨", sessionId: "same-cli" });
    options.onLine({ type: "status", text: "CLI 세션 연결됨", sessionId: "same-cli" });
    options.onLine({ type: "message", text: "최종 답변", finalText: "최종 답변" });
    options.onLine({ type: "message", text: "최종 답변", finalText: "최종 답변" });
    return { exitCode: 0, finalText: "최종 답변", sessionId: "same-cli" };
  });
  const session = await orchestra.create({ prompt: "중복 확인", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);
  assert.equal(session.events.filter((event) => event.text === "CLI 세션 연결됨").length, 1);
  assert.equal(session.events.filter((event) => event.text === "최종 답변").length, 1);
});

test("group assignment is included in persisted session snapshots", async () => {
  const snapshots: Array<Array<{ id: string; groupId?: string }>> = [];
  const orchestra = new Orchestra(() => undefined, async () => ({ exitCode: 0, finalText: "done" }), (sessions) => {
    snapshots.push(sessions.map(({ id, groupId }) => ({ id, groupId })));
  });
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const session = await orchestra.create({ prompt: "Grouped", agent: "codex", workers: ["claude"], cwd, groupId: "group-1" });
  orchestra.setGroup(session.id, "group-2");
  assert.equal(session.groupId, "group-2");
  assert.equal(snapshots.at(-1)?.[0].groupId, "group-2");
});

test("session rename and removal publish and persist their changes", async () => {
  const published: string[] = [];
  const removed: string[] = [];
  const snapshots: string[][] = [];
  const orchestra = new Orchestra(
    (session) => published.push(session.title),
    async () => ({ exitCode: 0, finalText: "done" }),
    (sessions) => { snapshots.push(sessions.map((session) => session.id)); },
    (sessionId) => removed.push(sessionId),
  );
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const session = await orchestra.create({ prompt: "Original", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);

  assert.equal(orchestra.rename(session.id, "Renamed").title, "Renamed");
  assert.equal(published.at(-1), "Renamed");
  orchestra.remove(session.id);

  assert.equal(orchestra.get(session.id), undefined);
  assert.deepEqual(removed, [session.id]);
  assert.deepEqual(snapshots.at(-1), []);
});

test("active sessions cannot be removed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const orchestra = new Orchestra(() => undefined, () => new Promise(() => undefined));
  const session = await orchestra.create({ prompt: "Still running", agent: "codex", workers: ["claude"], cwd });

  assert.throws(() => orchestra.remove(session.id), /실행 중인 세션은 삭제할 수 없습니다/);
  assert.equal(orchestra.get(session.id), session);
  orchestra.stop(session.id);
});

test("late runner events cannot republish a stopped and removed session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const published: string[] = [];
  let emitLateLine: (() => void) | undefined;
  let finishRun: (() => void) | undefined;
  const orchestra = new Orchestra(
    (session) => published.push(session.events.at(-1)?.text ?? ""),
    (options) => new Promise((resolve) => {
      emitLateLine = () => options.onLine({ type: "message", text: "late output" });
      finishRun = () => resolve({ exitCode: 143, finalText: "" });
    }),
  );
  const session = await orchestra.create({ prompt: "Long task", agent: "codex", workers: ["claude"], cwd });
  orchestra.stop(session.id);
  orchestra.remove(session.id);
  const publishedBeforeLateLine = published.length;

  emitLateLine?.();
  finishRun?.();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(session.events.some((event) => event.text === "late output"), false);
  assert.equal(published.length, publishedBeforeLateLine);
  assert.equal(orchestra.get(session.id), undefined);
});

test("a stopped run cannot fail or append output into a newer follow-up", async () => {
  let calls = 0;
  let rejectOld!: (error: Error) => void;
  let emitOld!: () => void;
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((_resolve, reject) => {
    calls += 1;
    if (calls === 1) {
      rejectOld = reject;
      emitOld = () => options.onLine({ type: "message", text: "stale output" });
    }
  });
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "First", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  orchestra.stop(session.id);

  await orchestra.followup(session.id, "Second");
  while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  emitOld();
  rejectOld(new Error("old run failed late"));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(session.status, "running");
  assert.equal(session.events.some((event) => event.text === "stale output"), false);
  assert.equal(session.events.some((event) => event.text === "old run failed late"), false);
  orchestra.stop(session.id);
});

test("a stopped run waiting for quota context cannot warn, hand off, or launch into a newer follow-up", async () => {
  let resolverCalls = 0;
  let rejectOld!: (error: Error) => void;
  const runnerPrompts: string[] = [];
  const quotaFallbackResolver = () => {
    resolverCalls += 1;
    if (resolverCalls === 1) return new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    return Promise.resolve({ enabled: false, threshold: 3, quotas: [], authenticated: ["codex" as const] });
  };
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>(() => {
    runnerPrompts.push(options.prompt);
  });
  const orchestra = new Orchestra(
    undefined, runner, undefined, undefined, undefined, undefined, undefined, quotaFallbackResolver,
  );
  const session = await orchestra.create({ prompt: "First", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  while (resolverCalls < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  orchestra.stop(session.id);

  await orchestra.followup(session.id, "Second");
  while (resolverCalls < 2 || runnerPrompts.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  rejectOld(new Error("old quota lookup failed"));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(session.status, "running");
  assert.equal(runnerPrompts.length, 1);
  assert.match(runnerPrompts[0], /Second/);
  assert.equal(session.events.some((event) => event.text.includes("한도 정보를 불러오지 못해")), false);
  assert.equal(session.events.some((event) => event.type === "handoff"), false);
  orchestra.stop(session.id);
});

test("follow-up applies skills selected for that message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  // Hermetic: a project-scoped fixture skill instead of whatever happens to be in the real home directory.
  await mkdir(join(cwd, ".claude", "skills", "followup-fixture"), { recursive: true });
  await writeFile(join(cwd, ".claude", "skills", "followup-fixture", "SKILL.md"),
    "---\nname: followup-fixture\ndescription: Fixture skill for follow-up tests\n---\nFixture body\n");
  const skill = (await publicSkills(cwd)).find((item) => item.name === "followup-fixture");
  assert.ok(skill, "expected the fixture skill to be discovered");
  const prompts: string[] = [];
  const orchestra = new Orchestra(() => undefined, async (options) => {
    prompts.push(options.prompt);
    return { exitCode: 0, finalText: "done" };
  });
  const session = await orchestra.create({ prompt: "First", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);
  await orchestra.followup(session.id, "Second", [skill.id]);
  await waitUntilSettled(session);
  assert.match(prompts[1], new RegExp(skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("stop aborts an active CLI run and reaches stopped state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  let observedAbort = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    options.signal?.addEventListener("abort", () => {
      observedAbort = true;
      resolve({ exitCode: 143, finalText: "" });
    }, { once: true });
    markStarted();
  });
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "Long task", agent: "codex", workers: ["claude"], cwd });
  await started;
  orchestra.stop(session.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(observedAbort, true);
  assert.equal(session.status, "stopped");
  assert.equal(session.events.at(-1)?.text, "중지됨");
});

test("an inactive run is aborted and reported as an error", async () => {
  let observedAbort = false;
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    options.signal?.addEventListener("abort", () => {
      observedAbort = true;
      resolve({ exitCode: 143, finalText: "" });
    }, { once: true });
  });
  const orchestra = new Orchestra(
    undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 20,
  );
  const session = await orchestra.create({ prompt: "Silent task", agent: "codex", workers: ["claude"], cwd: process.cwd() });

  await waitUntilSettled(session);

  assert.equal(observedAbort, true);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /새 이벤트가 없어 작업을 중단했습니다/);
});

test("run output resets the inactivity watchdog", async () => {
  let observedAbort = false;
  const runner = (options: RunCliOptions) => new Promise<{ exitCode: number; finalText: string }>((resolve) => {
    const first = setTimeout(() => options.onLine({ type: "status", text: "still working" }), 120);
    const second = setTimeout(() => resolve({ exitCode: 0, finalText: "done" }), 240);
    options.signal?.addEventListener("abort", () => {
      observedAbort = true;
      clearTimeout(first);
      clearTimeout(second);
      resolve({ exitCode: 143, finalText: "" });
    }, { once: true });
  });
  const orchestra = new Orchestra(
    undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 200,
  );
  const session = await orchestra.create({ prompt: "Active task", agent: "codex", workers: ["claude"], cwd: process.cwd() });

  await waitUntilSettled(session);

  assert.equal(observedAbort, false);
  assert.equal(session.status, "done");
});

test("a chat without workers gets the workspace's allowed agents instead of an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const runner = async (options: RunCliOptions) => {
    options.onLine({ type: "message", text: "done", finalText: "done" });
    return { exitCode: 0, finalText: "done" };
  };
  const orchestra = new Orchestra(() => undefined, runner, undefined, undefined, undefined, (id: string) => [...restrictedAgents(id)]);
  const session = await orchestra.create({ prompt: "No worker", agent: "claude", workers: [], cwd, workspaceId: "company" });
  assert.deepEqual(session.workers, ["claude", "grok"], "the agents the workspace allows");
  await waitUntilSettled(session);
  const noAgent = await orchestra.create({ prompt: "No team", agent: undefined as never, cwd, workspaceId: "company" });
  assert.equal(noAgent.agent, "claude");
  assert.deepEqual(noAgent.workers, ["claude", "grok"]);
  await waitUntilSettled(noAgent);
});

test("a chat without a first message opens empty and starts with its first follow-up", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    options.onLine({ type: "message", text: "hi", finalText: "hi" });
    return { exitCode: 0, finalText: "hi" };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  const session = await orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd });
  assert.equal(session.status, "done", "nothing runs");
  assert.equal(session.title, "새 채팅");
  assert.equal(session.turnCount, 0);
  assert.equal(prompts.length, 0, "no CLI started");
  assert.ok(!session.events.some((event) => event.agent === "user"), "no user message yet");
  assert.ok(session.events.some((event) => /빈 채팅을 열었습니다/u.test(event.text)));
  const titled = await orchestra.create({ prompt: "  ", title: "기획 회의", agent: "codex", workers: ["claude"], cwd });
  assert.equal(titled.title, "기획 회의");

  await orchestra.followup(session.id, "로그인 버그를 고쳐줘");
  await waitUntilSettled(session);
  assert.equal(session.title, "로그인 버그를 고쳐줘", "named by its first message");
  assert.equal(session.turnCount, 1);
  assert.equal(session.status, "done");
  assert.ok(prompts.some((prompt) => prompt.includes("로그인 버그를 고쳐줘")));
  assert.equal(session.events.filter((event) => event.agent === "user" && event.type === "message").length, 1);
});

test("company sessions reject Codex in every configured role before starting a CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-company-"));
  let calls = 0;
  const orchestra = new Orchestra(undefined, async () => {
    calls += 1;
    return { exitCode: 0, finalText: "unexpected" };
  }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);

  await assert.rejects(
    orchestra.create({ prompt: "blocked orchestrator", agent: "codex", workers: ["claude"], cwd, workspaceId: "company" }),
    codexBlocked,
  );
  await assert.rejects(
    orchestra.create({ prompt: "blocked worker", agent: "claude", workers: ["codex"], cwd, workspaceId: "company" }),
    codexBlocked,
  );
  await assert.rejects(
    orchestra.create({ prompt: "blocked planner", agent: "claude", workers: ["grok"], planner: { agent: "codex" }, cwd, workspaceId: "company" }),
    codexBlocked,
  );
  assert.equal(calls, 0);
});

test("workspace settings can narrow agents and no workspace id forces a restriction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-policy-"));
  const allowed = (workspaceId: string) => workspaceId === "personal"
    ? ["claude", "grok"] as const
    : ["codex", "claude", "grok"] as const;
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "done" }), undefined, undefined, undefined, allowed);

  await assert.rejects(
    orchestra.create({ prompt: "personal subset", agent: "codex", workers: ["claude"], cwd, workspaceId: "personal" }),
    codexBlocked,
  );
  const company = await orchestra.create({ prompt: "company allows codex", agent: "codex", workers: ["claude"], cwd, workspaceId: "company" });
  await waitUntilSettled(company);
  assert.equal(company.status, "done");
});

test("moving an archived Codex session is allowed but company follow-up and team changes are rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-moved-"));
  let calls = 0;
  const orchestra = new Orchestra(undefined, async () => {
    calls += 1;
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  const session = await orchestra.create({ prompt: "personal", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);
  orchestra.setWorkspace(session.id, "company");

  await assert.rejects(orchestra.followup(session.id, "blocked"), codexBlocked);
  assert.throws(
    () => orchestra.updateTeam(session.id, { agent: "claude", workers: ["codex"] }),
    codexBlocked,
  );
  assert.equal(session.status, "done");
  assert.equal(calls, 1);
});

test("editing a valid team clears a persisted planner that the workspace now prohibits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-stale-planner-"));
  let calls = 0;
  const orchestra = new Orchestra(undefined, async () => {
    calls += 1;
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  const session = await orchestra.create({
    prompt: "personal", agent: "claude", workers: ["grok"], planner: { agent: "codex", model: "stale-plan" }, cwd,
  });
  await waitUntilSettled(session);
  orchestra.setWorkspace(session.id, "company");
  await assert.rejects(orchestra.followup(session.id, "blocked"), codexBlocked);

  orchestra.updateTeam(session.id, { agent: "claude", workers: ["grok"] });
  assert.equal(session.planner, undefined);
  await orchestra.followup(session.id, "recovered");
  await waitUntilSettled(session);
  assert.equal(session.status, "done");
  assert.equal(calls, 3);
});

test("company bot conversations reject Codex before starting a CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-bots-company-"));
  let calls = 0;
  const orchestra = new Orchestra(undefined, async () => {
    calls += 1;
    return { exitCode: 0, finalText: "unexpected" };
  }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  const bots = [
    { id: "a", name: "A", agent: "claude" as const, skills: [], systemPrompt: "", createdAt: new Date().toISOString() },
    { id: "b", name: "B", agent: "codex" as const, skills: [], systemPrompt: "", createdAt: new Date().toISOString() },
  ];

  await assert.rejects(
    orchestra.conversation({ botA: "a", botB: "b", turns: 2, prompt: "talk", cwd, workspaceId: "company" }, bots),
    codexBlocked,
  );
  assert.equal(calls, 0);
});

async function waitUntilSettled(session: { status: string }) {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("session timeout")), 1_000);
    const poll = () => {
      if (session.status !== "running") { clearTimeout(deadline); resolve(); }
      else setTimeout(poll, 5);
    };
    poll();
  });
}

test("planner output is supplied to the orchestrator and each run records its app session role", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const calls: Array<Pick<RunCliOptions, "agent" | "prompt" | "model" | "reasoningEffort" | "resumeSessionId" | "readOnly" | "usageContext">> = [];
  const runner = async (options: RunCliOptions) => {
    calls.push({ agent: options.agent, prompt: options.prompt, model: options.model, reasoningEffort: options.reasoningEffort, resumeSessionId: options.resumeSessionId, readOnly: options.readOnly, usageContext: options.usageContext });
    if (calls.length === 1) {
      options.onLine({ type: "status", text: "계획 세션", sessionId: "planner-only" });
      return { exitCode: 0, finalText: "검증 가능한 계획", sessionId: "planner-only" };
    }
    if (calls.length === 2) return { exitCode: 0, finalText: '<<DELEGATE to="claude">>테스트 실행<</DELEGATE>>' };
    if (calls.length === 3) return { exitCode: 0, finalText: "테스트 통과" };
    return { exitCode: 0, finalText: "완료" };
  };
  const orchestra = new Orchestra(() => undefined, runner, undefined, undefined, undefined, undefined, "/tmp/orchestra-usage");
  const session = await orchestra.create({
    prompt: "기능 구현", agent: "codex", workers: ["claude"], cwd,
    model: "codex-main", reasoningEffort: "high",
    planner: { agent: "codex", model: "codex-plan", reasoningEffort: "low" },
    workerConfigs: [{ agent: "claude", model: "claude-worker", reasoningEffort: "xhigh" }],
  });
  await waitUntilSettled(session);

  assert.deepEqual(calls.map(({ agent, model, reasoningEffort }) => ({ agent, model, reasoningEffort })), [
    { agent: "codex", model: "codex-plan", reasoningEffort: "low" },
    { agent: "codex", model: "codex-main", reasoningEffort: "high" },
    { agent: "claude", model: "claude-worker", reasoningEffort: "xhigh" },
    { agent: "codex", model: "codex-main", reasoningEffort: "high" },
  ]);
  assert.match(calls[0].prompt, /도구를 호출하지 마세요/);
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[1].readOnly, false);
  assert.match(calls[1].prompt, /검증 가능한 계획/);
  assert.equal(calls[1].resumeSessionId, undefined);
  assert.equal(calls[3].readOnly, true);
  assert.equal(calls[3].resumeSessionId, undefined);
  assert.match(calls[3].prompt, /\[P0\]/);
  assert.match(calls[3].prompt, /## 진행/);
  assert.ok(calls[2].usageContext?.workerId, "a worker run says which worker it is");
  assert.deepEqual(calls.map(({ usageContext }) => { const { workerId: _w, ...rest } = usageContext ?? {} as NonNullable<typeof usageContext>; return rest; }), [
    { workspaceId: "personal", sessionId: session.id, role: "planner", dataDir: "/tmp/orchestra-usage" },
    { workspaceId: "personal", sessionId: session.id, role: "orchestrator", dataDir: "/tmp/orchestra-usage" },
    { workspaceId: "personal", sessionId: session.id, role: "worker", dataDir: "/tmp/orchestra-usage" },
    { workspaceId: "personal", sessionId: session.id, role: "orchestrator", dataDir: "/tmp/orchestra-usage" },
  ]);
  assert.deepEqual(session.planner, { agent: "codex", model: "codex-plan", reasoningEffort: "low" });
  assert.equal(session.status, "done");
});

test("a read-only review stays off the implementation session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-review-split-"));
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (calls.length === 1) {
      options.onLine({ type: "status", text: "connected", sessionId: "impl-session" });
      return { exitCode: 0, finalText: '<<DELEGATE to="claude">>버튼 수정. 제약: 기존 버그는 하지 말 것<</DELEGATE>>', sessionId: "impl-session" };
    }
    if (calls.length === 2) return { exitCode: 0, finalText: "구현함", sessionId: "worker-session" };
    if (calls.length === 3) return { exitCode: 0, finalText: "발견 없음", sessionId: "review-session" };
    return { exitCode: 0, finalText: "이어서 답" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "버튼을 고쳐줘", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);
  assert.equal(calls[2].readOnly, true);
  assert.equal(calls[2].resumeSessionId, undefined);
  assert.match(calls[2].prompt, /\[P0\]/);
  assert.match(calls[2].prompt, /## 진행/);
  assert.match(calls[2].prompt, /## 결정·제약/);
  assert.equal(session.cliSessionId, "impl-session");
  const followup = await orchestra.followup(session.id, "이어서 테스트까지");
  await waitUntilSettled(followup);
  assert.equal(calls[3].resumeSessionId, "impl-session");
  assert.match(calls[3].prompt, /이어받기 전 압축 요약/);
  assert.match(calls[3].prompt, /## 다음 단계/);
  assert.match(calls[3].prompt, /이어서 테스트까지/);
});

test("a failed worker makes the session fail without running synthesis", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const calls: string[] = [];
  const orchestra = new Orchestra(() => undefined, async (options) => {
    calls.push(options.agent);
    if (calls.length === 1) return { exitCode: 0, finalText: '<<DELEGATE to="claude">>실패 작업<</DELEGATE>>' };
    return { exitCode: 7, finalText: "worker failed" };
  });
  const session = await orchestra.create({ prompt: "작업", agent: "codex", workers: ["claude"], cwd });
  await waitUntilSettled(session);

  assert.equal(session.status, "error");
  assert.deepEqual(calls, ["codex", "claude"]);
  assert.match(session.events.at(-1)?.text ?? "", /Claude 워커가 종료 코드 7/);
});

async function settled(session: { status: string }) {
  for (let attempt = 0; attempt < 200 && session.status === "running"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.status, "done");
}

for (const workerAgent of ["codex", "claude", "grok"] as const) {
  test(`${workerAgent} worker reuses its own session across delegations, followups and restore`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orchestra-reuse-"));
    const primary = workerAgent === "codex" ? "claude" : "codex";
    const workerCalls: RunCliOptions[] = [];
    const primaryCalls: RunCliOptions[] = [];
    let phase = 0;
    const runner = async (options: RunCliOptions) => {
      if (options.agent === workerAgent) {
        workerCalls.push(options);
        options.onLine({ type: "status", text: "connected", sessionId: `worker-${workerAgent}` });
        // Streaming ID must be retained even when the result does not repeat it.
        return { exitCode: 0, finalText: "worker result" };
      }
      primaryCalls.push(options);
      return { exitCode: 0, finalText: phase++ % 2 === 0 ? `<<DELEGATE to="${workerAgent}">>first<</DELEGATE>><<DELEGATE to="${workerAgent}">>second<</DELEGATE>>` : "final", sessionId: "primary-id" };
    };
    const orchestra = new Orchestra(undefined, runner);
    const session = await orchestra.create({ prompt: "work", agent: primary, workers: [workerAgent], cwd });
    await settled(session);
    assert.deepEqual(workerCalls.map((call) => call.resumeSessionId), [undefined, `worker-${workerAgent}`]);
    assert.match(workerCalls[1].prompt, /이어받기 전 압축 요약/);
    assert.equal(session.cliSessionId, "primary-id");
    const restored = new Orchestra(undefined, runner);
    restored.restore([structuredClone(session)]);
    const followup = await restored.followup(session.id, "continue");
    await settled(followup);
    assert.deepEqual(workerCalls.slice(2).map((call) => call.resumeSessionId), [`worker-${workerAgent}`, `worker-${workerAgent}`]);
    assert.match(primaryCalls[2].prompt, /이전 작업의 맥락/);
    assert.match(primaryCalls[2].prompt, /이어받기 전 압축 요약/);
    assert.match(primaryCalls[2].prompt, /## 진행/);
    const separate = await orchestra.create({ prompt: "unrelated", agent: primary, workers: [workerAgent], cwd });
    await settled(separate);
    assert.equal(workerCalls[4].resumeSessionId, undefined);
  });
}

for (const failure of ["exit", "throw"] as const) {
  test(`worker starts a new session when resume fails (${failure})`, async () => {
    const calls: RunCliOptions[] = [];
    const orchestra = new Orchestra(undefined, async (options) => {
      calls.push(options);
      if (options.agent === "codex") return { exitCode: 0, finalText: calls.length === 1 ? '<<DELEGATE to="claude">>do work<</DELEGATE>>' : "final" };
      if (options.resumeSessionId) {
        if (failure === "throw") throw new Error("resume rejected");
        return { exitCode: 1, finalText: "" };
      }
      return { exitCode: 0, finalText: "done", sessionId: "replacement" };
    });
    orchestra.restore([{ id: "restore", agent: "codex", workers: ["claude"], workerSessionIds: { claude: "stale" }, title: "restore", cwd: process.cwd(), status: "done", events: [], createdAt: new Date().toISOString(), workspaceId: "personal" }]);
    const session = await orchestra.followup("restore", "work");
    await settled(session);
    assert.deepEqual(calls.filter((call) => call.agent === "claude").map((call) => call.resumeSessionId), ["stale", undefined]);
    assert.equal(session.workerSessionIds?.claude, "replacement");
    assert.equal(session.events.filter((event) => event.type === "delegation").length, 1);
  });
}

test("new session mode does not resume a prior worker session", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: options.agent === "codex" && calls.length === 1 ? '<<DELEGATE to="claude">>work<</DELEGATE>><<DELEGATE to="claude">>more<</DELEGATE>>' : "done", sessionId: options.agent === "claude" ? `new-${calls.length}` : "primary" };
  });
  orchestra.restore([{ id: "new", agent: "codex", workers: ["claude"], workerConfigs: [{ agent: "claude", sessionMode: "new" }], workerSessionIds: { claude: "old" }, title: "new", cwd: process.cwd(), status: "done", events: [], createdAt: new Date().toISOString(), workspaceId: "personal" }]);
  const session = await orchestra.followup("new", "work");
  await settled(session);
  assert.deepEqual(calls.filter((call) => call.agent === "claude").map((call) => call.resumeSessionId), [undefined, undefined]);
  assert.equal(session.workerSessionIds?.claude, "new-3");
});

test("a running Codex team cannot move into company", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const orchestra = new Orchestra(() => undefined, async () => { await gate; return { exitCode: 0, finalText: "done" }; }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  const session = await orchestra.create({ prompt: "work", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  try {
    assert.throws(() => orchestra.setWorkspace(session.id, "company"), /Codex/);
    assert.equal(session.workspaceId, "personal");
  } finally { release(); }
});

test("every new CLI launch checks the latest workspace policy", async () => {
  let allowed: ("codex" | "claude" | "grok")[] = ["codex", "claude", "grok"];
  const calls: string[] = [];
  const orchestra = new Orchestra(() => undefined, async (options) => {
    calls.push(options.agent);
    allowed = ["claude", "grok"];
    return { exitCode: 0, finalText: '<<DELEGATE to="codex">>work<</DELEGATE>>' };
  }, undefined, undefined, undefined, () => allowed);
  const session = await orchestra.create({ prompt: "work", agent: "claude", workers: ["codex"], cwd: process.cwd() });
  for (let attempt = 0; attempt < 100 && session.status === "running"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ["claude"]);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Codex/);
});

test("proactively switches every Codex team role to the best quota fallback", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude", "grok"],
    quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 2, resetsAt: 2_000_000_000 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
      { agent: "grok", windows: [{ key: "a", label: "a", remainingPercent: 50 }] },
    ],
  }));
  const session = await orchestra.create({
    prompt: "work", agent: "codex", workers: ["codex"], planner: { agent: "codex", model: "opus" }, cwd: process.cwd(),
    model: "gpt-5-codex", reasoningEffort: "high", workerConfigs: [{ agent: "codex", reasoningEffort: "high" }],
  });
  await waitUntilSettled(session);

  assert.deepEqual(calls.map((call) => call.agent), ["claude", "claude"]);
  const orchestration = calls.find((call) => call.prompt.includes("상위 명령자"));
  assert.match(orchestration?.prompt ?? "", /Claude 총괄/);
  assert.doesNotMatch(orchestration?.prompt ?? "", /Codex 총괄/);
  assert.equal(session.agent, "claude");
  assert.deepEqual(session.workers, ["claude"]);
  assert.equal(session.planner?.agent, "claude");
  assert.match(session.events.find((event) => event.metadata?.quotaFallback)?.text ?? "", /Codex 한도 소진 → Claude로 전환/);
});

test("known Grok exhaustion warns instead of sending media generation to another agent", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "unexpected" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["grok", "claude"], quotas: [
      { agent: "grok", windows: [{ key: "a", label: "a", remainingPercent: 0 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 90 }] },
    ],
  }));
  const session = await orchestra.create({ prompt: "광고 영상을 만들어줘", agent: "grok", workers: ["grok"], cwd: process.cwd() });
  await waitUntilSettled(session);

  assert.deepEqual(calls, []);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Grok 조정자를 사용할 수 없습니다/);
  assert.equal(session.events.some((event) => event.metadata?.quotaFallback), false);
});

test("thrown Grok quota errors do not fall back for media generation", async () => {
  const agents: string[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    agents.push(options.agent);
    throw new Error("quota exceeded");
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["grok", "claude"], quotas: [],
  }));
  const session = await orchestra.create({ prompt: "로고 시안을 만들어줘", agent: "grok", workers: ["grok"], cwd: process.cwd() });
  await waitUntilSettled(session);

  assert.deepEqual(agents, ["grok"]);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Grok 조정자를 사용할 수 없습니다/);
  assert.equal(session.events.some((event) => event.metadata?.quotaFallback), false);
});

test("observed Grok quota errors do not fall back for media generation", async () => {
  const agents: string[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    agents.push(options.agent);
    options.onLine({ type: "error", text: "usage limit reached" });
    return { exitCode: 1, finalText: "" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["grok", "claude"], quotas: [],
  }));
  const session = await orchestra.create({ prompt: "사진 편집해줘", agent: "grok", workers: ["grok"], cwd: process.cwd() });
  await waitUntilSettled(session);

  assert.deepEqual(agents, ["grok"]);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Grok 조정자를 사용할 수 없습니다/);
  assert.equal(session.events.some((event) => event.metadata?.quotaFallback), false);
});

test("retries a quota-failed worker once on fallback with task and partial log", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    if (calls.length === 1) return { exitCode: 0, finalText: '<<DELEGATE to="codex">>implement parser<</DELEGATE>>' };
    if (calls.length === 2) {
      options.onLine({ type: "message", text: "edited parser" });
      options.onLine({ type: "error", text: "usage limit reached" });
      return { exitCode: 1, finalText: "" };
    }
    return { exitCode: 0, finalText: calls.length === 3 ? "worker recovered" : "final" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude"], quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 50 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 90 }] },
    ],
  }));
  const session = await orchestra.create({ prompt: "work", agent: "grok", workers: ["codex"], cwd: process.cwd() });
  await waitUntilSettled(session);

  assert.deepEqual(calls.map((call) => call.agent), ["grok", "codex", "claude", "grok"]);
  assert.match(calls[1].prompt, /Codex 작업자/);
  assert.match(calls[2].prompt, /implement parser/);
  assert.match(calls[2].prompt, /edited parser/);
  assert.match(calls[2].prompt, /Claude 작업자/);
  assert.match(calls[2].prompt, /TodoWrite/);
  assert.doesNotMatch(calls[2].prompt, /Codex 작업자|허용된 프로그램/);
  assert.equal(session.status, "done");
  assert.deepEqual(session.workers, ["claude"]);
  const takeover = session.events.find((event) => event.delegationId && event.text === "작업을 이어받고 있습니다.");
  assert.equal(takeover?.agent, "claude");
  assert.equal(takeover?.taskStatus, "running");
  assert.equal(takeover?.model, undefined, "a worker on the CLI default keeps the CLI default after fallback");
  const completion = [...session.events].reverse().find((event) => event.delegationId && event.taskStatus === "done");
  assert.equal(completion?.agent, "claude");
  assert.equal(completion?.model, undefined);
});

test("worker quota fallback preserves an unrelated fallback-provider worker session", async () => {
  const orchestra = new Orchestra(undefined, async (options) => {
    if (options.usageContext?.role === "orchestrator" && options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "done" };
    if (options.usageContext?.role === "orchestrator") return { exitCode: 0, finalText: '<<DELEGATE to="claude">>first<</DELEGATE>><<DELEGATE to="codex">>second<</DELEGATE>>' };
    const sessionId = options.prompt.includes("first") ? "claude-thread" : "fallback-thread";
    return { exitCode: 0, finalText: "worker done", sessionId };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude", "grok"], quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 0 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
      { agent: "grok", windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
    ],
  }));
  const session = await orchestra.create({ prompt: "work", agent: "grok", workers: ["claude", "codex"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.equal(session.workerSessionIds?.claude, "claude-thread");
  assert.equal(session.workerSessionIds?.codex, "fallback-thread");
});

test("quota remapping keeps stable delegation ids and rebuilds the detailed worker roster", async () => {
  let prompt = "";
  const orchestra = new Orchestra(undefined, async (options) => {
    prompt = options.prompt;
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude"], quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 0 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
    ],
  }));
  const session = await orchestra.create({
    prompt: "work", agent: "codex", workers: ["codex", "codex"], cwd: process.cwd(),
    workerConfigs: [
      { id: "codex.review", label: "Codex Review", agent: "codex" },
      { id: "codex.build", label: "Codex Build", agent: "codex" },
    ],
  });
  await waitUntilSettled(session);
  assert.match(prompt, /codex\.review \(Codex Review \/ claude\), codex\.build \(Codex Build \/ claude\)/);
  assert.match(prompt, /Claude 총괄/);
  assert.doesNotMatch(prompt, /Codex 총괄/);
  assert.match(prompt, /<<DELEGATE to="codex\.review">>/);
  assert.doesNotMatch(prompt, /<<DELEGATE to="claude">>/);
});

test("returns to the exact prior quota-fallback team after reset", async () => {
  let recovered = false;
  const fallback = async () => ({
    enabled: true, threshold: 3, authenticated: ["codex" as const, "claude" as const], quotas: [
      { agent: "codex" as const, windows: [{ key: "a", label: "a", remainingPercent: recovered ? 75 : 0, resetsAt: recovered ? undefined : 2_000_000_000 }] },
      { agent: "claude" as const, windows: [{ key: "a", label: "a", remainingPercent: 90 }] },
    ],
  });
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "done" }), undefined, undefined, undefined, undefined, undefined, fallback);
  const session = await orchestra.create({
    prompt: "work", agent: "codex", workers: ["codex"], planner: { agent: "codex", model: "plan" }, cwd: process.cwd(),
    workerConfigs: [{ agent: "codex", model: "worker" }],
  });
  await waitUntilSettled(session);
  const handoff = session.events.find((event) => event.metadata?.quotaFallback)!;
  await assert.rejects(orchestra.returnFromQuotaFallback(session.id, handoff.id), /아직 복구되지 않았습니다/);
  recovered = true;
  await orchestra.returnFromQuotaFallback(session.id, handoff.id);
  assert.equal(session.agent, "codex");
  assert.deepEqual(session.workers, ["codex"]);
  assert.deepEqual(session.planner, { agent: "codex", model: "plan" });
  assert.equal(handoff.metadata?.undone, true);
});

test('expired quota observations allow an explicit return but active exhausted windows block it', async () => {
  const context = { enabled: true, threshold: 3, authenticated: ['codex', 'claude'] as ('codex'|'claude')[], quotas: [{ agent: 'codex' as const, updatedAt: new Date().toISOString(), windows: [{ key: 'five', label: 'five', remainingPercent: 0, resetsAt: Date.now() / 1000 - 5 }] }] };
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: 'done' }), undefined, undefined, undefined, undefined, undefined, async () => context);
  const previousConfig = { agent: 'codex' as const, workers: ['claude' as const] };
  const s = { id: 'reset-test', agent: 'claude' as const, workers: ['claude' as const], title: 'test', cwd: process.cwd(), status: 'done' as const, createdAt: '', workspaceId: 'personal' as const, events: [{ id: 'quota-switch', sessionId: 'reset-test', agent: 'claude' as const, type: 'handoff' as const, time: new Date().toISOString(), text: 'switch', metadata: { quotaFallback: true, from: 'codex' as const, to: 'claude' as const, resetsAt: Date.now() / 1000 - 5, previousConfig } }] };
  orchestra.restore([s]);
  context.quotas[0].windows.push({ key: 'week', label: 'week', remainingPercent: 0, resetsAt: Date.now() / 1000 + 500 });
  await assert.rejects(orchestra.returnFromQuotaFallback(s.id, 'quota-switch'), /아직 복구/);
  context.quotas[0].windows.pop();
  await orchestra.returnFromQuotaFallback(s.id, 'quota-switch');
  assert.equal(s.agent, 'codex');
});

test("a rejected normalized quota error falls back even when the CLI exits zero", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      options.onLine({ type: "error", text: '{"type":"rate_limit_event","status":"rejected"}' });
      return { exitCode: 0, finalText: "" };
    }
    return { exitCode: 0, finalText: "recovered" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude"], quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 50 }] },
      { agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 90 }] },
    ],
  }));
  const session = await orchestra.create({ prompt: "work", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.deepEqual(calls.map((call) => call.agent), ["codex", "claude"]);
  assert.equal(session.status, "done");
});

test("an ordinary message mentioning a usage limit does not trigger fallback after success", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    options.onLine({ type: "message", text: "Document the usage limit behavior" });
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude"], quotas: [],
  }));
  const session = await orchestra.create({ prompt: "work", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.deepEqual(calls.map((call) => call.agent), ["codex"]);
});

test("worker-only quota return labels the worker agents and preserves orchestrator state", async () => {
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "done" }), undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude", "grok"], quotas: [
      { agent: "codex", windows: [{ key: "a", label: "a", remainingPercent: 80 }] },
    ],
  }));
  const session = { id: "worker-return", agent: "grok" as const, workers: ["claude" as const], model: "grok-4.7", cliSessionId: "keep-root", handoffContext: "keep-handoff", workerSessionIds: { grok: "keep-other", claude: "fallback", codex: "old" }, title: "test", cwd: process.cwd(), status: "done" as const, createdAt: "", workspaceId: "personal" as const, events: [{ id: "worker-switch", sessionId: "worker-return", agent: "claude" as const, type: "handoff" as const, time: new Date().toISOString(), text: "switch", metadata: { quotaFallback: true, from: "codex" as const, to: "claude" as const, previousConfig: { agent: "grok" as const, model: "grok-4.7", workers: ["codex" as const] } } }] };
  orchestra.restore([session]);
  await orchestra.returnFromQuotaFallback(session.id, "worker-switch");
  assert.equal(session.cliSessionId, "keep-root");
  assert.equal(session.handoffContext, "keep-handoff");
  assert.equal(session.events.at(-1)?.text, "Claude → Codex로 돌아왔습니다");
  assert.equal(session.workerSessionIds.grok, "keep-other");
});

test("quota resolver failures emit one bounded warning and continue with the original agent", async () => {
  const calls: string[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options.agent);
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, undefined, undefined, async () => { throw new Error("quota store unavailable"); });
  const session = await orchestra.create({ prompt: "work", agent: "codex", workers: ["claude"], planner: { agent: "codex" }, cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.deepEqual(calls, ["codex", "codex"]);
  assert.equal(session.events.filter((event) => event.text.includes("한도 정보를 불러오지 못해")).length, 1);
});

test("company media creates and followups reject before session mutation or CLI launch", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  await assert.rejects(orchestra.create({ prompt: "이미지 생성", agent: "grok", workers: ["grok"], cwd: process.cwd(), workspaceId: "company" }), { message: mediaBlockedMessage });
  assert.equal(orchestra.list().length, 0);
  assert.equal(calls.length, 0);
  const session = await orchestra.create({ prompt: "ordinary task", agent: "grok", workers: ["grok"], cwd: process.cwd(), workspaceId: "company" });
  await waitUntilSettled(session);
  const before = structuredClone(session);
  await assert.rejects(orchestra.followup(session.id, "광고 영상 생성"), { message: mediaBlockedMessage });
  assert.deepEqual(session, before);
  assert.equal(calls.length, 1);
});

const mediaHint = "MEDIA_HINT: show the model and credits before generating.";
const hintPolicy = (id: string) => ({ ...defaultWorkspacePolicy(), ...(id === "personal" ? { mediaPrompt: mediaHint } : {}) });

test("media workers receive their workspace's media prompt and support Codex workers", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: calls.length === 1 ? '<<DELEGATE to="codex">>Prepare asset<</DELEGATE>>' : "done" };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hintPolicy);
  const session = await orchestra.create({ prompt: "이미지 생성", agent: "grok", workers: ["codex", "grok"], cwd: process.cwd(), workspaceId: "personal" });
  await waitUntilSettled(session);
  assert.equal(session.status, "done");
  assert.deepEqual(session.workers, ["codex", "grok"]);
  const worker = calls.find((call) => call.usageContext?.role === "worker");
  assert.equal(worker?.agent, "codex");
  assert.ok(worker?.prompt.startsWith(`${mediaHint}\n\n`));
});

test("ordinary workers and workspaces without a media prompt receive no media hint", async () => {
  for (const workspaceId of ["personal", "company"] as const) {
    const calls: RunCliOptions[] = [];
    const orchestra = new Orchestra(undefined, async (options) => {
      calls.push(options);
      return { exitCode: 0, finalText: calls.length === 1 ? '<<DELEGATE to="grok">>Research<</DELEGATE>>' : "done" };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hintPolicy);
    const session = await orchestra.create({ prompt: "Research", agent: "grok", workers: ["grok"], cwd: process.cwd(), workspaceId });
    await waitUntilSettled(session);
    assert.equal(calls.some((call) => call.prompt.includes(mediaHint)), false);
  }
});

test("company bot conversations reject media before launching either bot", async () => {
  let calls = 0;
  const orchestra = new Orchestra(undefined, async () => { calls++; return { exitCode: 0, finalText: "done" }; }, undefined, undefined, undefined, restrictedAgents, undefined, undefined, undefined, undefined, restrictedPolicy);
  await assert.rejects(orchestra.conversation({ botA: "a", botB: "b", turns: 1, prompt: "영상 생성", cwd: process.cwd(), workspaceId: "company" }, [
    { id: "a", name: "A", agent: "grok", skills: [], systemPrompt: "", createdAt: "" },
    { id: "b", name: "B", agent: "claude", skills: [], systemPrompt: "", createdAt: "" },
  ]), { message: mediaBlockedMessage });
  assert.equal(calls, 0);
  assert.equal(orchestra.list().length, 0);
});

test("personal media sessions preserve the recommended worker availability and configuration", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: "done" };
  });
  const session = await orchestra.create({ prompt: "이미지 생성", agent: "grok", workers: ["grok"], workerConfigs: [{ agent: "grok", id: "available-worker", model: "grok-4.7-build-fast" }], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.deepEqual(session.workers, ["grok"]);
  assert.equal(session.workerConfigs?.[0].id, "available-worker");
  assert.equal(session.workerConfigs?.[0].model, "grok-4.7-build-fast");
});

test("media followups honor the available workers returned by automatic routing", async () => {
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "done" }), undefined, undefined,
    async () => ({ agent: "grok", workers: ["grok"], confidence: 1, reason: "only Grok available" }));
  const session = await orchestra.create({ prompt: "ordinary", agent: "grok", workers: ["grok"], mode: "auto", cwd: process.cwd() });
  await waitUntilSettled(session);
  await orchestra.followup(session.id, "이미지 생성");
  await waitUntilSettled(session);
  assert.deepEqual(session.workers, ["grok"]);
});

test("Claude media helper workers never receive the workspace media prompt", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    return { exitCode: 0, finalText: calls.length === 1 ? '<<DELEGATE to="claude">>Plan the concept<</DELEGATE>>' : "done" };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hintPolicy);
  const session = await orchestra.create({ prompt: "이미지 생성", agent: "grok", workers: ["claude"], cwd: process.cwd(), workspaceId: "personal" });
  await waitUntilSettled(session);
  const worker = calls.find((call) => call.agent === "claude");
  assert.ok(worker);
  assert.equal(worker.prompt.includes(mediaHint), false);
});

test("manual media followups preserve an existing customized media team", async () => {
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "done" }), undefined, undefined, undefined, undefined, undefined, undefined,
    async (prompt) => prompt.includes("campaign"));
  const session = await orchestra.create({ prompt: "campaign draft", agent: "grok", workers: ["grok"], workerConfigs: [{ agent: "grok", id: "custom", model: "grok-4.7-build-fast" }], mode: "manual", cwd: process.cwd() });
  await waitUntilSettled(session);
  await orchestra.followup(session.id, "campaign revision");
  await waitUntilSettled(session);
  assert.deepEqual(session.workers, ["grok"]);
  assert.equal(session.workerConfigs?.[0].id, "custom");
  assert.equal(session.workerConfigs?.[0].model, "grok-4.7-build-fast");
});

test("a run ends after the worker round when the user denied computer use, without a review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-test-"));
  const roles: string[] = [];
  const runner = async (options: RunCliOptions) => {
    roles.push(options.usageContext?.role ?? "?");
    const text = roles.length === 1 ? '<<DELEGATE to="claude">>Open TextEdit<</DELEGATE>>' : "막힘: 사용자가 거부했습니다";
    options.onLine({ type: "message", text, finalText: text });
    return { exitCode: 0, finalText: text };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  orchestra.computerHalt = () => "denied";
  const session = await orchestra.create({ prompt: "TextEdit에 hello", agent: "grok", workers: ["claude"], cwd });
  await waitUntilSettled(session);
  assert.equal(session.status, "error");
  assert.equal(roles.length, 2, "lead + worker only; no review round");
  assert.match(session.events.at(-1)?.text ?? "", /컴퓨터 조작을 거부해 작업을 멈췄습니다/);
});

test("a failed worker whose tool output mentions 429 or quota is not handed to another agent", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options) => {
    calls.push(options);
    if (options.usageContext?.role === "worker") {
      // A screenshot read back as base64 and a doc about rate limits: tool output, not the provider.
      options.onLine?.({ type: "tool", text: "도구 결과: iVBORw0KGgo+429/AAAA quota exceeded on purpose in this doc" });
      return { exitCode: 1, finalText: "" };
    }
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>화면 확인<</DELEGATE>>' };
  }, undefined, undefined, undefined, undefined, undefined, async () => ({
    enabled: true, threshold: 3, authenticated: ["codex", "claude", "grok"],
    quotas: [{ agent: "claude", windows: [{ key: "a", label: "a", remainingPercent: 53 }] }],
  }));
  const session = await orchestra.create({ prompt: "확인해", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitUntilSettled(session);
  assert.equal(calls.filter((call) => call.usageContext?.role === "worker").every((call) => call.agent === "claude"), true);
  assert.equal(session.events.some((event) => event.metadata?.quotaFallback || /한도 소진/u.test(event.text)), false);
});
