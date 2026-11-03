import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { notesPath, parseAsks, parseNotes, reportDue, reportTime, STEWARD_ROLLOVER_TURNS, transcriptPath } from "./steward.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();

async function waitFor(predicate: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t: test.TestContext, name = "repo") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-steward-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, name);
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
  assert.match(leadPrompts[2], /지난 턴이 끝난 뒤 앱이 한 일[\s\S]*병합했습니다/u, "the next turn hears about the merge");
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

test("asks and report times are read from what the lead and the user wrote", () => {
  assert.deepEqual(parseAsks('앞 <<ASK to="서버">>\n포트가 뭐야?\n<</ASK>> <<ASK to="">>x<</ASK>>'), [{ to: "서버", text: "포트가 뭐야?" }]);
  assert.equal(reportTime("8:05"), "08:05");
  assert.equal(reportTime("24:00"), undefined);
  const now = new Date(2026, 10, 3, 9, 0);
  assert.equal(reportDue("08:00", undefined, now), true);
  assert.equal(reportDue("08:00", new Date(2026, 10, 3, 8, 1).toISOString(), now), false, "already reported today");
  assert.equal(reportDue("08:00", new Date(2026, 10, 2, 8, 1).toISOString(), now), true, "yesterday's report");
  assert.equal(reportDue("10:00", undefined, now), false, "not yet");
});

test("a lead asks another project's lead and gets the answer back in its own chat", async (t) => {
  const a = await setup(t, "app");
  const b = await setup(t, "api");
  const prompts: Array<{ cwd: string; prompt: string }> = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push({ cwd: options.cwd, prompt: options.prompt });
    if (options.prompt.includes("[담당 「app」이 보낸 질문]")) return { exitCode: 0, finalText: "포트는 4000입니다.\n<<NOTES>>\n- app이 포트를 물어봄\n<</NOTES>>" };
    if (options.prompt.includes("[담당 「api」의 답]")) return { exitCode: 0, finalText: "api 포트 4000으로 맞추겠습니다." };
    if (options.prompt.includes("사용자 요청:\n포트 확인")) return { exitCode: 0, finalText: '서버 담당에게 물어봅니다.\n<<ASK to="API">>지금 개발 서버 포트가 몇 번이야?<</ASK>>' };
    return { exitCode: 0, finalText: "준비했습니다." };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = a.dataDir;
  orchestra.stewardDataDir = a.dataDir;
  const app = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: {} });
  const api = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: b.repo, steward: {} });
  await waitFor(() => app.status === "done" && api.status === "done");
  assert.ok(app.steward && api.steward, "both start as leads");

  await orchestra.followup(app.id, "포트 확인");
  await waitFor(() => app.status === "done" && app.events.some((event) => event.agent === "user" && event.text.startsWith("[담당 「api」의 답]")) && prompts.some((item) => item.prompt.includes("[담당 「api」의 답]")), 10_000);
  const appLeadPrompt = prompts.find((item) => item.prompt.includes("사용자 요청:\n포트 확인"))!.prompt;
  assert.match(appLeadPrompt, /「api」 — /u, "a lead is told about the other leads");
  assert.ok(api.events.some((event) => event.agent === "user" && event.text.includes("지금 개발 서버 포트가 몇 번이야?")), "the question shows in the other lead's chat");
  const reply = app.events.find((event) => event.agent === "user" && event.text.startsWith("[담당 「api」의 답]"))!;
  assert.match(reply.text, /포트는 4000입니다/u);
  assert.doesNotMatch(reply.text, /<<NOTES>>/u, "the answer leaves the app's blocks out");
  assert.ok(app.events.some((event) => event.text.includes("「api」 담당에게 물었습니다")));
});

test("leads asking each other back and forth stop after a few hops", async (t) => {
  const a = await setup(t, "one");
  const b = await setup(t, "two");
  const runner = async (options: RunCliOptions) => {
    const other = options.cwd === a.repo ? "two" : "one";
    if (options.prompt.includes("사용자 요청:\n준비")) return { exitCode: 0, finalText: "준비했습니다." };
    return { exitCode: 0, finalText: `되물어 봅니다.\n<<ASK to="${other}">>확인 부탁 ${Math.random()}<</ASK>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.stewardDataDir = a.dataDir;
  const one = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: {} });
  await waitFor(() => one.status === "done");
  const two = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: b.repo, steward: {} });
  await waitFor(() => two.status === "done");
  await orchestra.followup(one.id, "시작");
  const warned = () => [...one.events, ...two.events].some((event) => event.type === "warning" && event.text.includes("주고받은 횟수"));
  await waitFor(() => warned() && one.status !== "running" && two.status !== "running", 10_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(one.status !== "running" && two.status !== "running", "the chain ended");
});

test("a lead's daily report opens a turn once its time has passed", async (t) => {
  const { repo, dataDir } = await setup(t);
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => { prompts.push(options.prompt); return { exitCode: 0, finalText: "보고: 변경 없음" }; };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "주식" } });
  await waitFor(() => chat.status === "done");
  orchestra.updateSteward(chat.id, { report: "08:00" });
  assert.equal(chat.steward!.name, "주식");
  orchestra.stewardTick(new Date(Date.now() + 60_000));
  assert.equal(prompts.length, 1, "set today: the first report waits for the next 08:00");
  chat.steward!.reportedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  orchestra.stewardTick();
  await waitFor(() => chat.status === "done" && prompts.length === 2);
  assert.match(prompts[1], /정기 보고/u);
  orchestra.stewardTick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(prompts.length, 2, "one report a day");
});

test("messages waiting for a lead survive a restart, and an answer cut off by it still reaches the asker", async (t) => {
  const a = await setup(t, "app");
  const b = await setup(t, "api");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = async (options: RunCliOptions) => {
    if (options.prompt.includes("사용자 요청:\n느린 일")) { await gate; return { exitCode: 0, finalText: "느린 일 끝" }; }
    if (options.prompt.includes("사용자 요청:\n포트 확인")) return { exitCode: 0, finalText: '<<ASK to="api">>포트?<</ASK>>' };
    return { exitCode: 0, finalText: "준비" };
  };
  const first = new Orchestra(undefined, runner);
  first.stewardDataDir = a.dataDir;
  const app = await first.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: {} });
  const api = await first.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: b.repo, steward: {} });
  await waitFor(() => app.status === "done" && api.status === "done");
  await first.followup(api.id, "느린 일");
  await first.followup(app.id, "포트 확인");
  await waitFor(() => app.status === "done" && Boolean(api.steward!.inbox?.length));
  // The app quits: the busy lead's run is cut off (as the server's recovery marks it) and its question waits on disk.
  const saved = JSON.parse(JSON.stringify([app, api])) as (typeof app)[];
  saved[1].status = "stopped";
  release();

  const prompts: string[] = [];
  const second = new Orchestra(undefined, async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    return { exitCode: 0, finalText: options.prompt.includes("이 보낸 질문") ? "포트는 4000" : "알겠습니다" };
  });
  second.stewardDataDir = a.dataDir;
  second.restore(saved);
  await second.stewardTick();
  const restoredApp = second.get(app.id)!;
  await waitFor(() => restoredApp.events.some((event) => event.text.startsWith("[담당 「api」의 답]")) && restoredApp.status === "done", 10_000);
  assert.match(restoredApp.events.find((event) => event.text.startsWith("[담당 「api」의 답]"))!.text, /포트는 4000/u);

  // Cut off while answering: the asker hears so instead of waiting forever.
  const cut = JSON.parse(JSON.stringify([second.get(app.id), second.get(api.id)])) as (typeof app)[];
  cut[1].steward!.answering = { id: app.id, question: "또 포트?", depth: 1 };
  const third = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "알겠습니다" }));
  third.stewardDataDir = a.dataDir;
  third.restore(cut);
  assert.equal(third.get(api.id)!.steward!.answering, undefined);
  assert.match(third.get(app.id)!.steward!.inbox?.[0]?.prompt ?? "", /답하지 못했습니다/u);
});

test("a lead answering another lead does not hand out work unless the user allowed it", async (t) => {
  const a = await setup(t, "app");
  const b = await setup(t, "api");
  const workerRuns = [] as string[];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") { workerRuns.push(options.cwd); return { exitCode: 0, finalText: "상태: 완료" }; }
    if (options.prompt.includes("이 보낸 질문")) return { exitCode: 0, finalText: '고치겠습니다.\n<<DELEGATE to="claude">>포트를 5000으로 바꾸기<</DELEGATE>>' };
    if (options.prompt.includes("사용자 요청:\n바꿔 달라고 해")) return { exitCode: 0, finalText: '<<ASK to="api">>포트를 5000으로 바꿔 줘<</ASK>>' };
    return { exitCode: 0, finalText: "준비" };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.stewardDataDir = a.dataDir;
  orchestra.worktreeDataDir = a.dataDir;
  const app = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: {} });
  const api = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: b.repo, steward: {} });
  await waitFor(() => app.status === "done" && api.status === "done");
  await orchestra.followup(app.id, "바꿔 달라고 해");
  await waitFor(() => app.events.some((event) => event.text.startsWith("[담당 「api」의 답]")) && app.status === "done" && api.status === "done", 10_000);
  assert.equal(workerRuns.length, 0, "no worker ran for the other lead");
  assert.ok(api.events.some((event) => event.type === "warning" && event.text.includes("워커에게 일을 맡기지 않았습니다")));
  assert.match(api.events.find((event) => event.text.startsWith("[담당 「app」이 보낸 질문]"))!.text, /확인만 하고 답하세요/u);

  orchestra.updateSteward(api.id, { acceptWork: true });
  await orchestra.followup(app.id, "바꿔 달라고 해");
  await waitFor(() => workerRuns.length === 1, 10_000);
  assert.equal(workerRuns[0].includes("api"), true, "allowed: the api lead's worker ran");
});

test("two leads cannot share a name", async (t) => {
  const a = await setup(t, "app");
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "준비" }));
  orchestra.stewardDataDir = a.dataDir;
  const one = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: { name: "주식" } });
  const two = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: a.repo, steward: { name: "개발" } });
  await waitFor(() => one.status === "done" && two.status === "done");
  assert.throws(() => orchestra.updateSteward(two.id, { name: "주식" }), /이미 「주식」 담당이 있습니다/u);
  await assert.rejects(orchestra.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: a.repo, steward: { name: "개발" } }), /이미 「개발」/u);
  orchestra.updateSteward(two.id, { name: "개발2" });
  assert.equal(two.steward!.name, "개발2");
});

test("a daily report is skipped when the project and the chat are unchanged", async (t) => {
  const { repo, dataDir } = await setup(t);
  const prompts: string[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => { prompts.push(options.prompt); return { exitCode: 0, finalText: "보고" }; });
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo, steward: {} });
  await waitFor(() => chat.status === "done");
  orchestra.updateSteward(chat.id, { report: "00:00" });
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  await orchestra.stewardTick(day(1));
  await waitFor(() => chat.status === "done" && prompts.length === 2);
  await orchestra.stewardTick(day(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(prompts.length, 2, "nothing changed: no report");
  await writeFile(join(repo, "new.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "change");
  await orchestra.stewardTick(day(3));
  await waitFor(() => chat.status === "done" && prompts.length === 3);
  assert.match(prompts[2], /정기 보고/u);
});
