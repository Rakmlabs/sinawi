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
  t.after(() => rm(base, { recursive: true, force: true }));
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
  assert.ok(prompts.some((prompt) => prompt.includes("끝까지 모드 1번째 이어가기")), "the app wrote the next turn's prompt");
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
      if (options.prompt.includes("다시 해")) return { exitCode: 0, finalText: "다시 시도합니다." };
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
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
});
