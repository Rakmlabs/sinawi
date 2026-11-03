import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { notesPath, parseNotes, STEWARD_ROLLOVER_TURNS, transcriptPath } from "./steward.js";

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
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-steward-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "README.md"), "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, dataDir: join(base, "data") };
}

test("the last notes block is the lead's notes", () => {
  assert.equal(parseNotes("앞 <<NOTES>>옛<</NOTES>> 뒤 <<NOTES>>\n- 결정: A\n<</NOTES>>"), "- 결정: A");
  assert.equal(parseNotes("노트 없음"), undefined);
});

test("a project lead keeps its notes and transcript, merges each turn's work and starts fresh when long", async (t) => {
  const { repo, dataDir } = await setup(t);
  const leadPrompts: string[] = [];
  let turn = 0;
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      await writeFile(join(options.cwd, `turn${turn}.txt`), `turn ${turn}\n`);
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    leadPrompts.push(options.prompt);
    turn++;
    return { exitCode: 0, sessionId: `cli-${turn}`, finalText: `일을 맡깁니다.\n<<DELEGATE to="claude">>파일 만들기<</DELEGATE>>\n<<NOTES>>\n- 지금까지 ${turn}턴\n<</NOTES>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "첫 일", agent: "codex", workers: ["claude"], cwd: repo });
  await waitFor(() => chat.status === "done");
  orchestra.setSteward(chat.id, true);
  // Close to the rollover: the next turn is the last on this CLI session.
  chat.steward!.turns = STEWARD_ROLLOVER_TURNS - 1;

  await orchestra.followup(chat.id, "둘째 일");
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.text.includes("새 세션으로 이어 갑니다")), 10_000);
  assert.equal(await readFile(join(repo, "turn2.txt"), "utf8"), "turn 2\n", "the lead's turn was merged into the main checkout");
  assert.match(git(repo, "log", "-1", "--format=%s"), /^Merge branch 'sinawi\//u);
  assert.equal(chat.worktrees, undefined, "merged worktrees are gone");
  assert.equal(await readFile(notesPath(dataDir, chat.id), "utf8"), "- 지금까지 2턴\n");
  const transcript = await readFile(transcriptPath(dataDir, chat.id), "utf8");
  assert.match(transcript, /둘째 일/u);
  assert.doesNotMatch(transcript, /<<NOTES>>/u);
  assert.equal(chat.cliSessionId, undefined, "the next turn starts a fresh CLI session");
  assert.match(chat.handoffContext ?? "", /지금까지 2턴/u, "the fresh session gets the notes");

  await orchestra.followup(chat.id, "셋째 일");
  await waitFor(() => chat.status === "done" && leadPrompts.length === 3, 10_000);
  assert.match(leadPrompts[2], /## 프로젝트 담당/u);
  assert.match(leadPrompts[2], /지금까지 2턴/u, "the notes come with every turn");
  assert.ok(leadPrompts[2].includes(transcriptPath(dataDir, chat.id)), "the lead is told where the transcript is");
  assert.equal(chat.steward!.turns, 1);
});

test("a lead's review of its workers gets the notes and the transcript too", async (t) => {
  const { repo, dataDir } = await setup(t);
  const leadPrompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      await writeFile(join(options.cwd, "a.txt"), "a\n");
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    leadPrompts.push(options.prompt);
    return { exitCode: 0, finalText: `<<CHECKLIST>>\n- [ ] a.txt 만들기\n<</CHECKLIST>>\n<<DELEGATE to="claude">>a.txt 만들기<</DELEGATE>>\n<<NOTES>>\n- 결정: 파일은 a.txt\n<</NOTES>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo });
  await waitFor(() => chat.status === "done");
  orchestra.setSteward(chat.id, true);
  await orchestra.followup(chat.id, "a.txt 만들어");
  await waitFor(() => leadPrompts.some((prompt) => prompt.startsWith("이어받기 전 압축 요약")), 10_000);
  const review = leadPrompts.find((prompt) => prompt.startsWith("이어받기 전 압축 요약"))!;
  assert.match(review, /## 프로젝트 담당/u);
  assert.match(review, /결정: 파일은 a\.txt/u, "the review sees the notes the lead just wrote");
  assert.ok(review.includes(transcriptPath(dataDir, chat.id)), "the review knows where the transcript is");
  await orchestra.stop(chat.id);
});

test("a lead's merge that fails keeps the branch and tries again after the next turn", async (t) => {
  const { repo, dataDir } = await setup(t);
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      await writeFile(join(options.cwd, "README.md"), "worker\n");
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    return { exitCode: 0, finalText: `<<DELEGATE to="claude">>README 고치기<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo });
  await waitFor(() => chat.status === "done");
  orchestra.setSteward(chat.id, true);
  // The user commits a change to the same line meanwhile: the worker's branch now conflicts.
  await writeFile(join(repo, "README.md"), "user\n");
  git(repo, "commit", "-qam", "user edit");
  await orchestra.followup(chat.id, "README 고쳐");
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.text.includes("병합하지 못했습니다")), 10_000);
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "user\n", "the main checkout is untouched");
  assert.equal(chat.worktrees?.length, 1, "the branch is kept for the next try");
});
