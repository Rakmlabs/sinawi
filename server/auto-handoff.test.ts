import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import type { AgentId, Session } from "./types.js";

async function settle(session: Session) {
  for (let attempt = 0; attempt < 200 && session.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(session.status, "running", "session did not settle");
}

async function fixture(
  autoRouter?: ConstructorParameters<typeof Orchestra>[4],
  runnerCalls: RunCliOptions[] = [],
) {
  const cwd = await mkdtemp(join(tmpdir(), "auto-handoff-"));
  const orchestra = new Orchestra(
    undefined,
    async (options) => {
      runnerCalls.push(options);
      const text = `answer-${runnerCalls.length}`;
      options.onLine({ type: "message", text, finalText: text, sessionId: `cli-${runnerCalls.length}` });
      return { exitCode: 0, finalText: text, sessionId: `cli-${runnerCalls.length}` };
    },
    undefined,
    undefined,
    autoRouter,
  );
  const session = await orchestra.create({
    prompt: "첫 요청",
    agent: "codex",
    model: "codex-main",
    reasoningEffort: "high",
    workers: ["claude", "grok"],
    workerConfigs: [
      { agent: "claude", model: "haiku", reasoningEffort: "low" },
      { agent: "grok", model: "grok-fast" },
    ],
    cwd,
    mode: "auto",
    autoSwitch: true,
  });
  await settle(session);
  return { orchestra, session };
}

test("automatic handoff reuses conversation summary and records reversible metadata", async () => {
  const calls: RunCliOptions[] = [];
  const { orchestra, session } = await fixture(
    async () => ({ agent: "claude", confidence: 0.96, reason: "설계 요청", workers: ["codex"] }),
    calls,
  );

  await orchestra.followup(session.id, "구조를 설계해 줘", [], { mode: "auto", autoSwitch: true });
  await settle(session);

  const handoff = session.events.find((event) => event.type === "handoff");
  assert.equal(session.agent, "claude");
  assert.equal(session.model, "haiku");
  assert.equal(handoff?.text, "오케스트라 변경: Codex → Claude (설계 요청)");
  assert.deepEqual(handoff?.metadata, {
    auto: true,
    from: "codex",
    to: "claude",
    reason: "설계 요청",
    previousConfig: {
      agent: "codex",
      model: "codex-main",
      reasoningEffort: "high",
      workers: ["claude", "grok"],
      workerConfigs: [
        { id: "claude", label: "Claude", agent: "claude", model: "haiku", reasoningEffort: "low" },
        { id: "grok", label: "Grok Build", agent: "grok", model: "grok-fast" },
      ],
    },
  });
  assert.equal(calls[1].agent, "claude");
  assert.equal(calls[1].resumeSessionId, undefined);
  assert.match(calls[1].prompt, /이전 오케스트라의 대화 요약/);
  assert.match(calls[1].prompt, /사용자: 첫 요청/);
  assert.match(calls[1].prompt, /Codex: answer-1/);
});

test("follow-up publishes the current user turn before automatic routing and records it once", async () => {
  let userEventsSeenByRouter = 0;
  const prompt = "현재 턴 요청";
  const { orchestra, session } = await fixture(async (routingSession) => {
    userEventsSeenByRouter = routingSession.events.filter((event) => event.type === "message" && event.agent === "user" && event.text === prompt).length;
    return undefined;
  });

  await orchestra.followup(session.id, prompt, [], { mode: "auto", autoSwitch: true });
  await settle(session);

  assert.equal(userEventsSeenByRouter, 1);
  assert.equal(session.events.filter((event) => event.type === "message" && event.agent === "user" && event.text === prompt).length, 1);
});

test("automatic handoff keeps the selected orchestrator for two complete following turns", async () => {
  let routeCalls = 0;
  const { orchestra, session } = await fixture(async () => {
    routeCalls += 1;
    return routeCalls === 1
      ? { agent: "claude", confidence: 0.99, reason: "설계", workers: ["codex"] }
      : { agent: "grok", confidence: 0.99, reason: "리서치", workers: ["codex"] };
  });

  for (const prompt of ["설계", "코딩 1", "코딩 2"]) {
    await orchestra.followup(session.id, prompt, [], { mode: "auto", autoSwitch: true });
    await settle(session);
  }
  assert.equal(routeCalls, 1);
  assert.equal(session.agent, "claude");
  assert.equal(session.turnCount, 4);

  await orchestra.followup(session.id, "조사", [], { mode: "auto", autoSwitch: true });
  await settle(session);
  assert.equal(routeCalls, 2);
  assert.equal(session.agent, "grok");
  assert.equal(session.lastAutoSwitchTurn, 5);
});

test("media follow-ups bypass the automatic-switch hold and use Codex and Grok workers", async () => {
  let routeCalls = 0;
  const { orchestra, session } = await fixture(async (_session, prompt) => {
    routeCalls += 1;
    return prompt.includes("영상")
      ? { agent: "grok", confidence: 1, reason: "미디어 생성", workers: ["codex", "grok"] }
      : { agent: "claude", confidence: 0.99, reason: "설계", workers: ["codex"] };
  });
  await orchestra.followup(session.id, "설계", [], { mode: "auto", autoSwitch: true });
  await settle(session);

  await orchestra.followup(session.id, "광고 영상을 만들어줘", [], { mode: "auto", autoSwitch: true });
  await settle(session);

  assert.equal(routeCalls, 2);
  assert.equal(session.agent, "grok");
  assert.equal(session.model, "grok-4.7");
  assert.deepEqual(session.workers, ["codex", "grok"]);
});

test("media follow-ups warn and do not run another provider when Grok is unavailable", async () => {
  const calls: RunCliOptions[] = [];
  const { orchestra, session } = await fixture(async () => undefined, calls);

  await orchestra.followup(session.id, "썸네일 이미지를 만들어줘", [], { mode: "auto", autoSwitch: true });

  assert.equal(calls.length, 1);
  assert.equal(session.status, "error");
  assert.match(session.events.at(-1)?.text ?? "", /Grok 조정자를 사용할 수 없습니다/);
});

test("manual mode and disabled automatic switching never invoke the classifier", async () => {
  let routeCalls = 0;
  const { orchestra, session } = await fixture(async () => {
    routeCalls += 1;
    return { agent: "claude", confidence: 1, reason: "unused", workers: ["codex"] };
  });

  await orchestra.followup(session.id, "수동 요청", [], { mode: "manual", autoSwitch: true });
  await settle(session);
  await orchestra.followup(session.id, "토글 꺼진 요청", [], { mode: "auto", autoSwitch: false });
  await settle(session);

  assert.equal(routeCalls, 0);
  assert.equal(session.agent, "codex");
  assert.equal(session.mode, "auto");
  assert.equal(session.autoSwitch, false);
});

test("undo restores the prior team and starts a new two-turn hold", async () => {
  let routeCalls = 0;
  const { orchestra, session } = await fixture(async () => {
    routeCalls += 1;
    return { agent: "claude", confidence: 0.98, reason: "설계", workers: ["codex"] };
  });
  await orchestra.followup(session.id, "설계", [], { mode: "auto", autoSwitch: true });
  await settle(session);
  const automatic = session.events.find((event) => event.type === "handoff" && event.metadata?.auto);
  assert.ok(automatic);

  orchestra.undoHandoff(session.id, automatic.id);
  assert.equal(session.agent, "codex");
  assert.equal(session.model, "codex-main");
  assert.equal(session.reasoningEffort, "high");
  assert.deepEqual(session.workers, ["claude", "grok"]);
  assert.equal(automatic.metadata?.undone, true);
  assert.equal(session.lastAutoSwitchTurn, 2);
  assert.throws(() => orchestra.undoHandoff(session.id, automatic.id), /되돌릴 수 있는 최신 자동 전환/);

  for (const prompt of ["유지 1", "유지 2"]) {
    await orchestra.followup(session.id, prompt, [], { mode: "auto", autoSwitch: true });
    await settle(session);
  }
  assert.equal(routeCalls, 1);
  assert.equal(session.agent, "codex");

  await orchestra.followup(session.id, "이제 전환", [], { mode: "auto", autoSwitch: true });
  await settle(session);
  assert.equal(routeCalls, 2);
  assert.equal(session.agent, "claude");
});

test("restored turn counters preserve the automatic-switch hold", async () => {
  const { orchestra, session } = await fixture(
    async () => ({ agent: "claude", confidence: 0.99, reason: "설계", workers: ["codex"] }),
  );
  await orchestra.followup(session.id, "설계", [], { mode: "auto", autoSwitch: true });
  await settle(session);

  let restoredRouteCalls = 0;
  const restored = new Orchestra(
    undefined,
    async () => ({ exitCode: 0, finalText: "restored answer" }),
    undefined,
    undefined,
    async () => {
      restoredRouteCalls += 1;
      return { agent: "grok", confidence: 0.99, reason: "조사", workers: ["codex"] };
    },
  );
  restored.restore([structuredClone(session)]);
  const current = restored.get(session.id)!;

  for (const prompt of ["복원 1", "복원 2"]) {
    await restored.followup(current.id, prompt, [], { mode: "auto", autoSwitch: true });
    await settle(current);
  }
  assert.equal(restoredRouteCalls, 0);
  assert.equal(current.agent, "claude");

  await restored.followup(current.id, "복원 3", [], { mode: "auto", autoSwitch: true });
  await settle(current);
  assert.equal(restoredRouteCalls, 1);
  assert.equal(current.agent, "grok");
});

test("stopping during classification aborts the follow-up without switching or executing", async () => {
  const calls: RunCliOptions[] = [];
  let classificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { classificationStarted = resolve; });
  const { orchestra, session } = await fixture(
    (_session, _prompt, signal) => new Promise((resolve) => {
      classificationStarted();
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
    calls,
  );

  const following = orchestra.followup(session.id, "분류 중 중지", [], { mode: "auto", autoSwitch: true });
  await started;
  orchestra.stop(session.id);
  await following;

  assert.equal(session.status, "stopped");
  assert.equal(session.agent, "codex");
  assert.equal(calls.length, 1);
  assert.equal(session.events.filter((event) => event.agent === "user" && event.text === "분류 중 중지").length, 1);
  assert.equal(session.events.some((event) => event.type === "handoff"), false);
});

