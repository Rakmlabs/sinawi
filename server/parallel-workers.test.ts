import test from "node:test";
import assert from "node:assert/strict";
import { Orchestra } from "./orchestra.js";
import type { RunCliOptions } from "./cli.js";
import { briefSkillNames, skillCatalog, workerSkillSection } from "./skill-routing.js";

async function waitFor(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error("timed out waiting for the running session");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("different workers run at once; one worker's briefs run in order; reports keep delegation order", async () => {
  const running = new Set<string>();
  let overlap = false;
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    const role = options.usageContext?.role;
    if (role === "worker") {
      const task = options.prompt.match(/TASK-(\S+?)(?:\s|$)/u)?.[1] ?? "?";
      const worker = options.usageContext?.workerId ?? "?";
      assert.equal(running.has(worker), false, "one worker never runs two briefs at once");
      running.add(worker);
      if (running.size > 1) overlap = true;
      order.push(`start ${task}`);
      await new Promise<void>((resolve) => gates.set(task, resolve));
      running.delete(worker);
      order.push(`end ${task}`);
      return { exitCode: 0, finalText: `상태: 완료\n${task} 끝` };
    }
    return { exitCode: 0, finalText: '<<DELEGATE to="claude-1">>TASK-A1<</DELEGATE>><<DELEGATE to="claude-2">>TASK-B<</DELEGATE>><<DELEGATE to="claude-1">>TASK-A2<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({
    prompt: "나눠서 해", agent: "codex", workers: ["claude", "claude"], cwd: process.cwd(),
    workerConfigs: [{ agent: "claude", label: "A" }, { agent: "claude", label: "B" }],
  });
  await waitFor(() => gates.has("A1") && gates.has("B"));
  assert.equal(overlap, true, "A and B started before either finished");
  assert.equal(gates.has("A2"), false, "A2 waits for A1 on the same worker");
  gates.get("B")!();
  gates.get("A1")!();
  await waitFor(() => gates.has("A2"));
  gates.get("A2")!();
  await waitFor(() => session.status !== "running");
  assert.equal(session.status, "done");
  assert.ok(order.indexOf("end A1") < order.indexOf("start A2"));
  const answer = session.events.filter((event) => event.type === "message" && event.role === "orchestrator").at(-1)?.text ?? "";
  assert.ok(answer.indexOf("A1 끝") < answer.indexOf("B 끝") && answer.indexOf("B 끝") < answer.indexOf("A2 끝"), "reports in the lead's delegation order");
});

test("a failing worker fails the session once the others have finished", async () => {
  let releaseB = () => {};
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      if (options.usageContext.workerId === "claude-1") return { exitCode: 3, finalText: "" };
      await new Promise<void>((resolve) => { releaseB = resolve; });
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    return { exitCode: 0, finalText: '<<DELEGATE to="claude-1">>작업 A<</DELEGATE>><<DELEGATE to="claude-2">>작업 B<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({
    prompt: "해", agent: "codex", workers: ["claude", "claude"], cwd: process.cwd(),
    workerConfigs: [{ agent: "claude", label: "A" }, { agent: "claude", label: "B" }],
  });
  await waitFor(() => session.events.some((event) => event.type === "error" && /종료 코드 3/u.test(event.text)));
  assert.equal(session.status, "running", "B is still working");
  releaseB();
  await waitFor(() => session.status !== "running");
  assert.equal(session.status, "error");
});

test("the lead sees installed skills and a brief's skills reach the worker", () => {
  const skills = [
    { id: "1", name: "impeccable", description: "Design and polish frontend UI.\nLong text", agents: ["claude" as const], source: "Claude", content: "IMPECCABLE BODY" },
    { id: "2", name: "impeccable", description: "duplicate from a plugin", agents: ["codex" as const], source: "Codex", content: "CODEX COPY" },
    { id: "3", name: "frontend-design", description: "Distinctive visual design", agents: ["claude" as const], source: "Claude", content: "FRONTEND BODY" },
  ];
  const catalog = skillCatalog(skills);
  assert.match(catalog, /## 설치된 스킬/);
  assert.match(catalog, /- impeccable \[claude,codex\]: Design and polish frontend UI\. Long text/);
  assert.equal(catalog.match(/- impeccable/g)?.length, 1, "each name once");
  assert.equal(skillCatalog([]), "");

  assert.deepEqual(briefSkillNames("스킬: `impeccable`, /frontend-design\n## 목표\nx"), ["impeccable", "frontend-design"]);
  assert.deepEqual(briefSkillNames("## 스킬: 없음"), []);
  assert.deepEqual(briefSkillNames("## 목표\n스킬을 잘 써라"), []);

  const claude = workerSkillSection("스킬: impeccable, frontend-design, nope\n## 목표\nx", skills, "claude");
  assert.match(claude, /Skill 도구로 연다: `impeccable`, `frontend-design`/);
  assert.doesNotMatch(claude, /BODY/, "a Claude worker opens its own skills");
  assert.match(claude, /설치되지 않은 스킬[^\n]*nope/);
  const codex = workerSkillSection("스킬: impeccable, frontend-design", skills, "codex");
  assert.match(codex, /스킬로 열어[^\n]*`impeccable`/, "Codex has its own impeccable");
  assert.match(codex, /FRONTEND BODY/, "a skill the CLI lacks is attached");
  assert.equal(workerSkillSection("## 목표\nx", skills, "claude"), "");
});

test("Claude Design is not advertised or opened headlessly while local design skills remain runnable", () => {
  const designSkills = [
    { id: "design", name: "design", description: "Claude Design", agents: ["claude" as const], source: "claude", content: "Use /design" },
    { id: "claude-design", name: "Claude Design", description: "Artboards", agents: ["claude" as const], source: "claude", content: "Use /design" },
    { id: "frontend", name: "frontend-design", description: "Local UI guidance", agents: ["claude" as const, "codex" as const], source: "project", content: "Build HTML" },
  ];
  const catalog = skillCatalog(designSkills);
  assert.doesNotMatch(catalog, /^- (?:design|Claude Design)\b/mu);
  assert.match(catalog, /frontend-design/);
  assert.match(catalog, /disable-model-invocation/);
  assert.deepEqual(briefSkillNames("스킬: /design, Claude Design, frontend-design"), ["frontend-design"]);

  const claude = workerSkillSection("스킬: /design, frontend-design\n## 목표\n목업", designSkills, "claude");
  assert.match(claude, /frontend-design/);
  assert.match(claude, /\/design.*호출하지 않는다/);
  assert.match(claude, /사용자.*터미널.*선택.*수동/);
});
