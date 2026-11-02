import test from "node:test";
import assert from "node:assert/strict";
import { Orchestra } from "./orchestra.js";
import type { RunCliOptions } from "./cli.js";

async function waitFor(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1_000) throw new Error("timed out waiting for the running session");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a running session answers status from the log and delivers a directive on the named worker's next turn", async () => {
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => { releaseWorker = () => resolve(); });
  let blocked = false;
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (options.readOnly) return { exitCode: 0, finalText: "B가 npm test를 실행 중입니다." };
    if (options.usageContext?.role === "worker") {
      options.onLine({ type: "command", text: "npm test" });
      if (!blocked) {
        blocked = true;
        await workerGate;
      }
      return { exitCode: 0, finalText: "worker done" };
    }
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "final" };
    return { exitCode: 0, finalText: '<<DELEGATE to="claude-1">>첫 작업<</DELEGATE>><<DELEGATE to="claude-2">>둘째 작업<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({
    prompt: "작업 시작",
    agent: "codex",
    workers: ["claude", "claude"],
    cwd: process.cwd(),
    workerConfigs: [{ agent: "claude", label: "A" }, { agent: "claude", label: "B" }],
  });
  await waitFor(() => session.events.some((event) => event.type === "command" && event.text === "npm test"));
  const workerSignal = calls.find((call) => call.usageContext?.role === "worker")?.signal;

  await orchestra.liveTurn(session.id, "뭐하고 있어?");
  assert.equal(session.status, "running");
  const statusCall = calls.find((call) => call.readOnly);
  assert.ok(statusCall);
  assert.equal(statusCall.agent, "grok");
  assert.equal(statusCall.model, "grok-4.7-build-fast");
  assert.equal(statusCall.resumeSessionId, undefined);
  assert.notEqual(statusCall.signal, workerSignal);
  assert.match(statusCall.prompt, /파일을 수정하지 말고/);
  assert.match(statusCall.prompt, /npm test/);
  assert.equal(statusCall.usageContext?.role, "status");
  const statusEvent = session.events.find((event) => event.metadata?.live === "status");
  assert.equal(statusEvent?.text, "B가 npm test를 실행 중입니다.");
  assert.equal(statusEvent?.metadata?.ambiguous, false);

  const beforeDirective = calls.length;
  await orchestra.liveTurn(session.id, "B한테 A부터 보라고 해");
  assert.equal(calls.length, beforeDirective);
  assert.equal(session.status, "running");
  assert.match(session.events.find((event) => event.metadata?.live === "directive")?.text ?? "", /B의 다음 턴/);
  assert.equal(session.pendingInstructions?.some((item) => item.targetWorkerId === "claude-2"), true);

  const beforeUnclear = calls.length;
  for (const instruction of ["옆 문서를 먼저", "추가로 모든 함수에 JSDoc 주석도 달아줘."]) {
    await orchestra.liveTurn(session.id, instruction);
    assert.equal(session.pendingInstructions?.some((item) => item.text === instruction && !item.targetWorkerId), true, `${instruction} reaches the lead`);
  }
  assert.equal(calls.length, beforeUnclear, "an unclear message is queued, not answered by a status run");
  assert.equal(session.events.some((event) => event.metadata?.ambiguous), false);

  releaseWorker();
  await waitFor(() => session.status !== "running");
  assert.equal(session.status, "done");
  const workerPrompts = calls.filter((call) => call.usageContext?.role === "worker").map((call) => call.prompt);
  assert.equal(workerPrompts.length, 2);
  assert.doesNotMatch(workerPrompts[0], /A부터 보/);
  assert.match(workerPrompts[1], /A부터 보라고 해/);
  assert.doesNotMatch(workerPrompts[1], /옆 문서를 먼저/);
  const synthesis = calls.find((call) => call.prompt.includes("위임한 워커들의 결과"));
  assert.match(synthesis?.prompt ?? "", /옆 문서를 먼저/);
  assert.equal(session.pendingInstructions, undefined);
  assert.equal(session.events.some((event) => event.agent === "grok" && event.type === "tool"), false);
});

test("a status agent failure leaves the running task untouched", async () => {
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => { releaseWorker = () => resolve(); });
  const runner = async (options: RunCliOptions) => {
    if (options.readOnly) throw new Error("status cli unavailable");
    if (options.usageContext?.role === "worker") {
      await workerGate;
      return { exitCode: 0, finalText: "done" };
    }
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "final" };
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>조사<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "조사", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitFor(() => callsWaiting(session));
  await orchestra.liveTurn(session.id, "뭐하고 있어?");
  assert.equal(session.status, "running");
  assert.match(session.events.find((event) => event.metadata?.live === "status")?.text ?? "", /그대로 진행/);
  await orchestra.liveTurn(session.id, "중지");
  assert.equal(session.status, "stopped");
  releaseWorker();
});

function callsWaiting(session: { events: Array<{ type: string; role?: string }> }): boolean {
  return session.events.some((event) => event.type === "delegation");
}

test("a live status question obeys the workspace agent policy like any other run", async () => {
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => { releaseWorker = () => resolve(); });
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    if (options.readOnly) return { exitCode: 0, finalText: "상태" };
    if (options.usageContext?.role === "worker") { await workerGate; return { exitCode: 0, finalText: "worker done" }; }
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "final" };
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>조사<</DELEGATE>>' };
  };
  let allowed: Array<"codex" | "claude" | "grok"> = ["codex", "claude", "grok"];
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, () => allowed);
  const session = await orchestra.create({ prompt: "조사", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitFor(() => callsWaiting(session));
  allowed = ["codex", "claude"];
  const eventsBefore = session.events.length;
  await assert.rejects(orchestra.liveTurn(session.id, "뭐하고 있어?"), /Grok Build/);
  assert.equal(calls.some((call) => call.readOnly), false, "Grok must not be spawned when the workspace forbids it");
  assert.equal(session.events.length, eventsBefore);
  assert.equal(session.status, "running");
  await orchestra.stop(session.id);
  releaseWorker();
});

test("promoting a live answer republishes a full snapshot so clients see the promoted flag", async () => {
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => { releaseWorker = () => resolve(); });
  const runner = async (options: RunCliOptions) => {
    if (options.readOnly) return { exitCode: 0, finalText: "상태" };
    if (options.usageContext?.role === "worker") { await workerGate; return { exitCode: 0, finalText: "worker done" }; }
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "final" };
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>조사<</DELEGATE>>' };
  };
  const publishes: Array<boolean> = [];
  const orchestra = new Orchestra((_session, options) => { publishes.push(Boolean(options?.full)); }, runner);
  const session = await orchestra.create({ prompt: "조사", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitFor(() => callsWaiting(session));
  // Answers saved by older versions can still carry the promote button.
  const answer = { id: "old-answer", sessionId: session.id, agent: "grok" as const, type: "message" as const, text: "상태", time: new Date().toISOString(), metadata: { live: "status" as const, ambiguous: true, prompt: "중지하지 마" } };
  session.events.push(answer);
  assert.equal(publishes.includes(true), false);
  orchestra.promoteLive(session.id, answer.id);
  assert.equal(publishes.at(-1), true);
  assert.equal(publishes.filter(Boolean).length, 1, "only the rewrite publish is a full snapshot");
  await orchestra.stop(session.id);
  releaseWorker();
});

test("a directive queued while the lead answers starts the next turn when the run ends", async () => {
  let releaseLead = () => {};
  const leadGate = new Promise<void>((resolve) => { releaseLead = () => resolve(); });
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.readOnly) return { exitCode: 0, finalText: "status" };
    prompts.push(options.prompt);
    if (prompts.length === 1) await leadGate;
    return { exitCode: 0, finalText: "답변" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "작업끝난거야?", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitFor(() => prompts.length === 1);
  await orchestra.liveTurn(session.id, "배포까지 해줘야돼");
  assert.ok(session.pendingInstructions?.length);
  releaseLead();
  await waitFor(() => prompts.length === 2 && session.status === "done");
  assert.match(prompts[1], /배포까지 해줘야돼/);
  assert.doesNotMatch(prompts[1], /진행 중에 보낸 지시입니다/);
  assert.equal(session.pendingInstructions, undefined);
  assert.equal(session.events.filter((event) => event.agent === "user" && event.text === "배포까지 해줘야돼").length, 1, "the queued message is not logged twice");
});

test("a message left from a stopped run reaches the next turn as older than the new one", async () => {
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.readOnly) return { exitCode: 0, finalText: "status" };
    prompts.push(options.prompt);
    if (prompts.length === 1) await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
    return { exitCode: 0, finalText: "답변" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "롤백해줘", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  await waitFor(() => prompts.length === 1);
  await orchestra.liveTurn(session.id, "배포까지 해줘야돼");
  await orchestra.stop(session.id);
  await waitFor(() => session.status === "stopped");
  await orchestra.followup(session.id, "이전꺼로 돌려놔줘");
  await waitFor(() => session.status === "done");
  const last = prompts[prompts.length - 1];
  assert.ok(last.indexOf("배포까지 해줘야돼") < last.indexOf("이전꺼로 돌려놔줘"));
  assert.match(last, /최근 메시지를 따르세요/);
  assert.doesNotMatch(last, /진행 중에 보낸 지시입니다/);
});
