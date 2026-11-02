import assert from "node:assert/strict";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import type { Session, WorkspacePolicy } from "./types.js";
import { defaultWorkspacePolicy } from "./workspace-policy.js";

async function settle(session: Session) {
  const start = Date.now();
  while (session.status === "running") {
    if (Date.now() - start > 2_000) throw new Error("run did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function orchestraWith(policy: WorkspacePolicy, runner: (options: RunCliOptions) => Promise<{ exitCode: number; finalText: string }>) {
  return new Orchestra(undefined, runner, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => policy);
}

const delegate = '<<DELEGATE to="claude">>main을 되돌린다<</DELEGATE>>';

test("plan mode runs only the lead, read-only, and hands nothing to workers", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = orchestraWith(defaultWorkspacePolicy(), async (options) => { calls.push(options); return { exitCode: 0, finalText: `계획\n${delegate}` }; });
  const session = await orchestra.create({ prompt: "기존꺼로 롤백", agent: "codex", workers: ["claude"], cwd: process.cwd(), permissionMode: "plan" });
  await settle(session);
  assert.equal(session.status, "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].readOnly, true);
  assert.match(calls[0].prompt, /## 계획 모드/);
  assert.ok(!calls[0].fullAccess);

  // "이대로 실행": the next turn in auto mode may write and delegate.
  await orchestra.followup(session.id, "위 계획대로 실행해줘.", [], { permissionMode: "auto" });
  await settle(session);
  assert.equal(session.permissionMode, "auto");
  assert.ok(calls.slice(1).some((call) => call.usageContext?.role === "worker" && !call.readOnly));
  assert.doesNotMatch(calls[1].prompt, /## 계획 모드/);
});

test("full access needs the workspace switch; sessions without a mode follow it", async () => {
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => { calls.push(options); return { exitCode: 0, finalText: "답" }; };
  const closed = orchestraWith(defaultWorkspacePolicy(), runner);
  await assert.rejects(closed.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: process.cwd(), permissionMode: "full" }), /전체 권한 모드가 꺼져/);

  const open = orchestraWith({ ...defaultWorkspacePolicy(), fullAccess: true }, runner);
  const full = await open.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: process.cwd(), permissionMode: "full" });
  await settle(full);
  assert.equal(calls.at(-1)?.fullAccess, true);
  const auto = await open.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: process.cwd(), permissionMode: "auto" });
  await settle(auto);
  assert.ok(!calls.at(-1)?.fullAccess, "auto stays sandboxed even where full access is allowed");
  const legacy = await open.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await settle(legacy);
  assert.equal(calls.at(-1)?.fullAccess, true, "a session without a mode keeps the old workspace behaviour");
});

test("auto never stops to ask the user; only plan mode collects questions", async () => {
  const prompts: string[] = [];
  const orchestra = orchestraWith(defaultWorkspacePolicy(), async (options) => { prompts.push(options.prompt); return { exitCode: 0, finalText: "답" }; });
  for (const permissionMode of ["auto", "plan"] as const) {
    const session = await orchestra.create({ prompt: "기존꺼로 돌려줘", agent: "codex", workers: ["claude"], cwd: process.cwd(), permissionMode });
    await settle(session);
  }
  assert.match(prompts[0], /사용자에게 되묻지 않는다/);
  assert.doesNotMatch(prompts[0], /확인을 받는다|어느 쪽인지 묻는다/);
  assert.match(prompts[0], /스킬/);
  assert.match(prompts[1], /모호한 점은 계획 끝에 질문으로/);
  assert.doesNotMatch(prompts[1], /되묻지 않는다/);
});

test("/compact drops the CLI sessions so the next turn starts fresh from a summary", async () => {
  const calls: RunCliOptions[] = [];
  const orchestra = orchestraWith(defaultWorkspacePolicy(), async (options) => { calls.push(options); return { exitCode: 0, finalText: "답", sessionId: "cli-1" }; });
  const session = await orchestra.create({ prompt: "첫 요청", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.cliSessionId, "cli-1");
  orchestra.compact(session.id);
  assert.equal(session.cliSessionId, undefined);
  await orchestra.followup(session.id, "다음 요청");
  await settle(session);
  const next = calls.at(-1)!;
  assert.equal(next.resumeSessionId, undefined, "no resume after compaction");
  assert.match(next.prompt, /이전 오케스트라의 대화 요약:[\s\S]*첫 요청/);
});
