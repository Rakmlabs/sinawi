import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { nextGoalStep, parseChecklist, parseGoals, GOAL_MAX_IDLE_TURNS } from "./goals.js";
import { Orchestra } from "./orchestra.js";
import { ensureWorkerWorktree, mergeWorktree } from "./worktrees.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();

async function waitFor(predicate: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tempRepo(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-goal-")));
  // A stopped run prunes its worktrees in the background, so git may still be writing in .git here.
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  await writeFile(join(repo, "README.md"), "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, dataDir: join(base, "data") };
}

const checklist = (...items: string[]) => `<<CHECKLIST>>\n${items.join("\n")}\n<</CHECKLIST>>`;

test("the checklist is the last block of a message; marks map to open, done and blocked", () => {
  const items = parseChecklist(`앞\n${checklist("- [ ] 옛것")}\n뒤\n${checklist("- [x] 로그인 화면", "- [ ] API 연동", "- [!] 결제 키 — 사용자가 키를 줘야 함")}`);
  assert.deepEqual(items, [
    { text: "로그인 화면", status: "done" },
    { text: "API 연동", status: "open" },
    { text: "결제 키", status: "blocked", note: "사용자가 키를 줘야 함" },
  ]);
  assert.equal(parseChecklist("체크리스트 없음"), undefined);
});

test("goals keep their order and only wait on goals that exist", () => {
  const goals = parseGoals('<<GOAL id="a" title="화면">>화면 만들기<</GOAL>>\n<<GOAL id="b" after="a, zz, old">>## API\n연동<</GOAL>>', ["old"]);
  assert.deepEqual(goals.map((goal) => [goal.key, goal.title, goal.after]), [["a", "화면", []], ["b", "API", ["a", "old"]]]);
});

test("the loop stops when settled, after idle turns, and at the turn budget", () => {
  const goal = (items: ("open" | "done")[], extra = {}) => ({ goal: { items: items.map((status) => ({ text: "x", status })), startedAt: new Date().toISOString(), autoTurns: 0, idleTurns: 0, ...extra } });
  assert.deepEqual(nextGoalStep(goal(["done", "done"])), { continue: false, reason: "complete" });
  assert.deepEqual(nextGoalStep(goal(["open"])), { continue: true });
  assert.deepEqual(nextGoalStep(goal(["open"], { idleTurns: GOAL_MAX_IDLE_TURNS })), { continue: false, reason: "idle" });
  assert.deepEqual(nextGoalStep(goal(["open"], { autoTurns: 99 })), { continue: false, reason: "turns" });
  assert.deepEqual(nextGoalStep({ goal: undefined }), { continue: false, reason: "no-checklist" });
});

test("a goal session opens turns by itself until its checklist is done", async () => {
  const prompts: string[] = [];
  let reviews = 0;
  const runner = async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 완료\n했음" };
    if (options.readOnly) {
      reviews++;
      return { exitCode: 0, finalText: reviews === 1 ? checklist("- [x] A", "- [ ] B") : checklist("- [x] A", "- [x] B") };
    }
    return { exitCode: 0, finalText: `${checklist("- [ ] A", "- [ ] B")}\n<<DELEGATE to="claude">>다음 항목<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "A와 B를 해", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
  await waitFor(() => Boolean(session.goal?.stopped));
  assert.equal(session.goal!.outcome, "complete");
  assert.equal(session.goal!.autoTurns, 1);
  assert.deepEqual(session.goal!.items.map((item) => item.status), ["done", "done"]);
  assert.ok(prompts.some((prompt) => prompt.includes("[앱 — 1번째 이어가기]")), "the app wrote the next turn's prompt");
  assert.ok(prompts[0].includes("<<CHECKLIST>>"), "the lead is told to keep a checklist");
});

test("a goal session that makes no progress stops after the idle limit", async () => {
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 완료" };
    return { exitCode: 0, finalText: `${checklist("- [ ] A")}\n<<DELEGATE to="claude">>A<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "A", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
  await waitFor(() => Boolean(session.goal?.stopped));
  assert.equal(session.goal!.outcome, "unfinished");
  assert.equal(session.goal!.autoTurns, GOAL_MAX_IDLE_TURNS);
  assert.equal(session.status, "done");
});

test("a commander runs goals in order, merges each into the main checkout and reports", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    if (options.usageContext?.role === "worker") {
      const file = /FILE-(\w+)/u.exec(options.prompt)?.[1] ?? "x";
      await writeFile(join(options.cwd, `${file}.txt`), `${file}\n`);
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    if (options.prompt.includes("당신은 Sinawi의 총지휘입니다")) {
      if (options.prompt.includes("모든 목표가 끝났습니다")) return { exitCode: 0, finalText: "정리: 둘 다 병합됨" };
      return { exitCode: 0, finalText: '<<GOAL id="g1" title="첫째">>FILE-one 만들기<</GOAL>>\n<<GOAL id="g2" title="둘째" after="g1">>FILE-two 만들기<</GOAL>>' };
    }
    if (options.readOnly) return { exitCode: 0, finalText: checklist("- [x] 파일") };
    const file = /FILE-(\w+)/u.exec(options.prompt)?.[1];
    return { exitCode: 0, finalText: `${checklist("- [ ] 파일")}\n<<DELEGATE to="claude">>FILE-${file}<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const commander = await orchestra.create({ prompt: "둘 다 해", agent: "codex", workers: ["claude"], cwd: repo, commander: true });
  await waitFor(() => commander.commander!.goals.length === 2 && commander.commander!.goals.every((goal) => goal.state === "merged") && commander.status === "done" && prompts.some((prompt) => prompt.includes("[앱] 모든 목표가 끝났습니다")), 15_000);
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
  const [first, second] = commander.commander!.goals.map((goal) => orchestra.get(goal.childId!)!);
  assert.equal(first.parentId, commander.id);
  assert.ok(second.createdAt >= commander.commander!.goals[0].endedAt!, "g2 started after g1 was merged");
  assert.equal(git(repo, "status", "--porcelain"), "", "the main tree is clean after the merges");
  assert.equal(git(repo, "branch", "--list", "sinawi/*"), "", "merged goal branches are deleted");
});

test("a merge that would conflict leaves the main tree and the branch alone", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "abcdef12-0000", workerId: "claude", cwd: repo }))!;
  await writeFile(join(info.path, "README.md"), "from worker\n");
  await writeFile(join(repo, "README.md"), "from main\n");
  git(repo, "commit", "-qam", "main edit");
  const result = await mergeWorktree(info, "merge");
  assert.equal(result.ok, false);
  assert.match(result.text, /충돌/u);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "from main\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.ok(git(repo, "branch", "--list", info.branch), "the branch is kept");
});

test("a merge commits the worker's uncommitted files and keeps the user's own local changes", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  await mkdir(join(repo, "notes"), { recursive: true });
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "abcdef12-0001", workerId: "claude", cwd: repo }))!;
  await writeFile(join(info.path, "feature.txt"), "feature\n");
  await writeFile(join(repo, "README.md"), "user edit, not committed\n");
  const result = await mergeWorktree(info, "merge goal");
  assert.equal(result.ok, true, result.text);
  assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "user edit, not committed\n");
  assert.equal(git(repo, "log", "-1", "--format=%b"), "merge goal");
});

test("a merge leaves out agent plugin state that differs from the main tree's own copy", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "abcdef12-0003", workerId: "claude", cwd: repo }))!;
  await mkdir(join(repo, ".omc"), { recursive: true });
  await mkdir(join(info.path, ".omc"), { recursive: true });
  await writeFile(join(repo, ".omc", "project-memory.json"), '{"main":true}\n');
  await writeFile(join(info.path, ".omc", "project-memory.json"), '{"worker":true}\n');
  await writeFile(join(info.path, "feature.txt"), "feature\n");
  const result = await mergeWorktree(info, "merge goal");
  assert.equal(result.ok, true, result.text);
  assert.equal(await readFile(join(repo, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await readFile(join(repo, ".omc", "project-memory.json"), "utf8"), '{"main":true}\n', "the main tree's state file is untouched");
  assert.equal(git(repo, "ls-files", ".omc"), "", "plugin state is not committed");
});

test("a merge goes through a repository whose commit-msg hook rejects the app's wording", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  await mkdir(join(repo, ".hooks"), { recursive: true });
  await writeFile(join(repo, ".hooks", "commit-msg"), "#!/bin/sh\ngrep -qE '^(feat|fix|chore)' \"$1\" || { echo 'subject must be conventional' >&2; exit 1; }\n", { mode: 0o755 });
  git(repo, "config", "core.hooksPath", ".hooks");
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "abcdef12-0002", workerId: "claude", cwd: repo }))!;
  await writeFile(join(info.path, "feature.txt"), "feature\n");
  git(info.path, "add", "-A");
  git(info.path, "commit", "-qm", "feat: feature");
  const result = await mergeWorktree(info, "sinawi: 목표 g1 기능");
  assert.equal(result.ok, true, result.text);
  assert.match(git(repo, "log", "-1", "--format=%s"), /^Merge branch 'sinawi\//u);
});

test("writing to the commander again retries a goal whose merge failed and the goals waiting on it", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      const file = /FILE-(\w+)/u.exec(options.prompt)?.[1] ?? "x";
      await writeFile(join(options.cwd, `${file}.txt`), `${file}\n`);
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    if (options.prompt.includes("당신은 Sinawi의 총지휘입니다")) {
      // Restates a goal the board already has, as a real lead did: the app must not run it twice.
      if (options.prompt.includes("다시 해")) return { exitCode: 0, finalText: '다시 시도합니다.\n<<GOAL id="g9" title="둘째">>FILE-two<</GOAL>>' };
      if (options.prompt.includes("모든 목표가 끝났습니다")) return { exitCode: 0, finalText: "정리" };
      return { exitCode: 0, finalText: '<<GOAL id="g1" title="첫째">>FILE-one<</GOAL>>\n<<GOAL id="g2" title="둘째" after="g1">>FILE-two<</GOAL>>' };
    }
    if (options.readOnly) return { exitCode: 0, finalText: checklist("- [x] 파일") };
    const file = /FILE-(\w+)/u.exec(options.prompt)?.[1];
    return { exitCode: 0, finalText: `${checklist("- [ ] 파일")}\n<<DELEGATE to="claude">>FILE-${file}<</DELEGATE>>` };
  };
  // The main checkout sits on a detached HEAD at first, so the first merge is refused.
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", head);
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const commander = await orchestra.create({ prompt: "둘 다 해", agent: "codex", workers: ["claude"], cwd: repo, commander: true });
  await waitFor(() => commander.commander!.goals.length === 2 && commander.commander!.goals.every((goal) => goal.state === "blocked") && commander.status === "done" && commander.commander!.reported === true, 15_000);
  git(repo, "checkout", "-q", "main");
  await orchestra.followup(commander.id, "다시 해");
  await waitFor(() => commander.commander!.goals.every((goal) => goal.state === "merged"), 15_000);
  assert.equal(commander.commander!.goals.length, 2, "the restated goal was not added again");
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
});

test("an ordinary answer in a chat that runs to completion ends after one turn", async () => {
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => { prompts.push(options.prompt); return { exitCode: 0, finalText: "답입니다." }; };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "이게 뭐야?", agent: "codex", workers: ["claude"], cwd: process.cwd(), autoRun: true });
  await waitFor(() => session.status === "done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(prompts.length, 1, "no turn of its own followed");
  assert.equal(session.events.filter((event) => event.type === "warning").length, 0);
  assert.ok(session.events.some((event) => event.text === "세션이 완료되었습니다."));
});

test("a chat splits a big request into goal chats, merges them, reports and is an ordinary chat again", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const leadPrompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      const file = /FILE-(\w+)/u.exec(options.prompt)?.[1] ?? "x";
      await writeFile(join(options.cwd, `${file}.txt`), `${file}\n`);
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    if (options.prompt.includes("당신은 Sinawi의 총지휘입니다")) return { exitCode: 0, finalText: "정리: 둘 다 병합됨" };
    if (options.prompt.includes("## 큰 일 나누기")) {
      leadPrompts.push(options.prompt);
      return { exitCode: 0, finalText: leadPrompts.length === 1 ? '둘로 나눕니다.\n<<GOAL id="g1" title="첫째">>FILE-one<</GOAL>>\n<<GOAL id="g2" title="둘째">>FILE-two<</GOAL>>' : "고맙습니다." };
    }
    if (options.readOnly) return { exitCode: 0, finalText: checklist("- [x] 파일") };
    const file = /FILE-(\w+)/u.exec(options.prompt)?.[1];
    return { exitCode: 0, finalText: `${checklist("- [ ] 파일")}\n<<DELEGATE to="claude">>FILE-${file}<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "둘 다 해", agent: "codex", workers: ["claude"], cwd: repo, autoRun: true });
  await waitFor(() => chat.commander?.goals.length === 2 && chat.commander.goals.every((goal) => goal.state === "merged") && chat.status === "done" && chat.commander.reported === true && !chat.commander.reporting, 15_000);
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
  for (const goal of chat.commander!.goals) {
    const child = orchestra.get(goal.childId!)!;
    assert.equal(child.parentId, chat.id);
    assert.ok(!child.events.some((event) => event.text.includes("큰 일 나누기")), "a goal chat does not split again");
  }
  await orchestra.followup(chat.id, "고마워", [], { autoRun: true });
  await waitFor(() => chat.status === "done" && leadPrompts.length === 2, 5_000);
  assert.ok(leadPrompts[1].includes("이 채팅이 앞서 나눠 맡긴 목표"), "the ordinary turn sees the earlier board");
});

test("stopping a chat that split its work stops its goal chats and starts no more", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
      return { exitCode: 130, finalText: "" };
    }
    if (options.prompt.includes("당신은 Sinawi의 총지휘입니다")) return { exitCode: 0, finalText: "정리" };
    if (options.prompt.includes("## 큰 일 나누기")) return { exitCode: 0, finalText: '<<GOAL id="g1" title="첫째">>FILE-one<</GOAL>>\n<<GOAL id="g2" title="둘째" after="g1">>FILE-two<</GOAL>>' };
    return { exitCode: 0, finalText: `${checklist("- [ ] 파일")}\n<<DELEGATE to="claude">>FILE-one<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "둘 다 해", agent: "codex", workers: ["claude"], cwd: repo, autoRun: true });
  await waitFor(() => chat.commander?.goals[0]?.state === "running" && orchestra.get(chat.commander.goals[0].childId ?? "")?.events.some((event) => event.type === "delegation") === true, 10_000);
  orchestra.stop(chat.id);
  const child = orchestra.get(chat.commander!.goals[0].childId!)!;
  await waitFor(() => child.status === "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(chat.commander!.goals.map((goal) => goal.state), ["stopped", "stopped"]);
  assert.equal(chat.commander!.goals[1].childId, undefined, "the waiting goal never started");
  assert.equal(child.goal?.outcome, "stopped");
  assert.ok(!chat.events.some((event) => event.text.includes("결과를 정리합니다")), "no summary turn after a stop");
});

test("goal chats wait at skill choices, preserve open work, and resume on a user pick", async () => {
  for (const withChecklist of [false, true]) {
    let turns = 0;
    const runner = async (options: RunCliOptions) => {
      turns++;
      const finalText = turns === 1
        ? `${withChecklist ? checklist("- [ ] UI 구현") : ""}\n어떤 스킬을 쓸까요?\n1. frontend-design — UI 구현\n2. 스킬 없이 진행`
        : checklist("- [x] UI 구현");
      options.onLine({ type: "message", text: finalText });
      return { exitCode: 0, finalText };
    };
    const orchestra = new Orchestra(undefined, runner);
    const session = await orchestra.create({ prompt: "UI 구현", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
    session.parentId = "commander-test";
    await waitFor(() => session.status !== "running");
    assert.equal(turns, 1, "a choice must not trigger an automatic delegation turn");
    assert.equal(session.goal!.stopped, undefined);
    assert.equal(session.goal!.autoTurns, 0);
    if (withChecklist) assert.equal(session.goal!.items[0].status, "open");
    await orchestra.followup(session.id, "frontend-design 선택");
    await waitFor(() => Boolean(session.goal?.stopped));
    assert.equal(turns, 2);
    assert.equal(session.goal!.outcome, "complete");
  }
});

test("goal choice pauses use the complete current answer across streamed chunks", async () => {
  let turns = 0;
  const runner = async (options: RunCliOptions) => {
    turns++;
    if (turns === 1) {
      options.onLine({ type: "message", text: "어떤 스킬을 쓸까요?\n1. first" });
      options.onLine({ type: "message", text: "\n2. 스킬 없이 진행" });
      return { exitCode: 0, finalText: `${checklist("- [ ] 구현")}\n어떤 스킬을 쓸까요?\n1. first\n2. 스킬 없이 진행` };
    }
    return { exitCode: 0, finalText: checklist("- [x] 구현") };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "구현", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
  await waitFor(() => session.status !== "running");
  assert.equal(turns, 1);
  assert.equal(session.goal?.stopped, undefined);
  await orchestra.followup(session.id, "2");
  await waitFor(() => session.status !== "running");
  assert.equal(session.goal?.outcome, "complete");
});

test("a previous choice does not pause later goal turns with no emitted message", async () => {
  let turns = 0;
  const runner = async (options: RunCliOptions) => {
    turns++;
    const finalText = turns === 1
      ? `${checklist("- [ ] 구현")}\n어떤 스킬을 쓸까요?\n1. first\n2. 스킬 없이 진행`
      : checklist(turns === 2 ? "- [ ] 구현" : "- [x] 구현");
    if (turns === 1) options.onLine({ type: "message", text: finalText });
    return { exitCode: 0, finalText };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "구현", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
  await waitFor(() => session.status !== "running");
  await orchestra.followup(session.id, "2");
  await waitFor(() => session.status !== "running");
  assert.equal(turns, 3);
  assert.equal(session.goal?.outcome, "complete");
});

test("a completed checklist settles even when the answer offers optional next work", async () => {
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    const finalText = `${checklist("- [x] 구현")}\n다음에는 무엇을 할까요?\n1. 문서 작성\n2. 종료`;
    options.onLine({ type: "message", text: finalText });
    return { exitCode: 0, finalText };
  });
  const session = await orchestra.create({ prompt: "구현", agent: "codex", workers: ["claude"], cwd: process.cwd(), goal: true });
  await waitFor(() => session.status !== "running");
  assert.equal(session.goal?.outcome, "complete");
});

test("a skill choice after an interrupted worker pauses forced replanning", async () => {
  let leadTurns = 0;
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      options.onLine({ type: "error", text: "중단되었습니다 (fixture)" });
      return { exitCode: 0, finalText: "부분 결과" };
    }
    leadTurns++;
    const finalText = leadTurns === 1
      ? `${checklist("- [ ] 구현")}\n<<DELEGATE to="codex">>구현<</DELEGATE>>`
      : `${checklist("- [ ] 구현")}\n다른 스킬로 시도할까요?\n1. fixture-review\n2. 스킬 없이 진행`;
    options.onLine({ type: "message", text: finalText });
    return { exitCode: 0, finalText };
  });
  const session = await orchestra.create({ prompt: "구현", agent: "grok", workers: ["codex"], cwd: process.cwd(), goal: true });
  await waitFor(() => session.status !== "running");
  assert.equal(leadTurns, 2);
  assert.equal(session.goal?.stopped, undefined);
  assert.ok(!session.events.some((event) => event.metadata?.phase === "self-work"));
});
