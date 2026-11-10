import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import { mergeRule, mergeThreadReports, notesPath, parseAsks, parseLeadCreates, parseNotes, reportDue, reportTime, saveNotes, saveUserPreferences, sessionSummary, STEWARD_ROLLOVER_TURNS, stewardFromSession, stewardRules, transcriptPath } from "./steward.js";
import type { Session, Steward } from "./types.js";

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
  orchestra.patchSteward(chat.steward!.id!, { mergePolicy: "auto" });
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
  orchestra.patchSteward(chat.steward!.id!, { mergePolicy: "auto" });
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
  orchestra.getSteward(chat.steward!.id!)!.reportedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  // A local clock past today's 08:00, whatever the machine's time zone and time of day.
  const afterReport = new Date();
  afterReport.setHours(9, 0, 0, 0);
  orchestra.stewardTick(afterReport);
  await waitFor(() => chat.status === "done" && prompts.length === 2);
  assert.match(prompts[1], /정기 보고/u);
  orchestra.stewardTick(afterReport);
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

test("concurrent lead chat creation reserves an explicit name only once", async (t) => {
  const { repo } = await setup(t, "parallel");
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "준비" }));
  const results = await Promise.allSettled([
    orchestra.create({ prompt: "one", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "Same" } }),
    orchestra.create({ prompt: "two", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "Same" } }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(orchestra.listStewards("personal").filter((item) => item.name === "Same").length, 1);
});

test("implicit folder names are checked when creating or enabling a lead", async (t) => {
  const { repo } = await setup(t, "same-folder");
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "준비" }));
  const first = await orchestra.create({ prompt: "one", agent: "codex", workers: ["claude"], cwd: repo, workspaceId: "personal", steward: {} });
  await waitFor(() => first.status === "done");
  await assert.rejects(
    orchestra.create({ prompt: "two", agent: "codex", workers: ["claude"], cwd: repo, workspaceId: "personal", steward: {} }),
    /이미 「same-folder」 담당/u,
  );
  const plain = await orchestra.create({ prompt: "plain", agent: "codex", workers: ["claude"], cwd: repo, workspaceId: "personal" });
  await waitFor(() => plain.status === "done");
  assert.throws(() => orchestra.setSteward(plain.id, true), /이미 「same-folder」 담당/u);
  assert.equal(plain.steward, undefined);
});

test("re-enabling a running former lead validates its lead workspace policy before moving", async (t) => {
  const { repo } = await setup(t, "policy");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const allowed = (workspaceId: string) => workspaceId === "company" ? ["claude", "grok"] as const : ["codex", "claude", "grok"] as const;
  const orchestra = new Orchestra(undefined, async () => { await gate; return { exitCode: 0, finalText: "done" }; }, undefined, undefined, undefined, allowed);
  const chat = await orchestra.create({ prompt: "start", agent: "codex", workers: ["claude"], cwd: repo, workspaceId: "personal", steward: { name: "Policy" } });
  orchestra.setSteward(chat.id, false);
  orchestra.patchSteward(chat.id, {}, "company");
  assert.equal(chat.workspaceId, "personal");
  assert.throws(() => orchestra.setSteward(chat.id, true), /Codex/u);
  assert.equal(chat.workspaceId, "personal");
  assert.equal(chat.steward, undefined);
  release();
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

// --- Leads as entities, merge policy, preferences, CLI switch, rollover, summary -----------------

/** A lead whose worker writes `file` in its worktree each turn. */
async function leadWithWorker(t: test.TestContext, file = "work.txt") {
  const { repo, dataDir } = await setup(t);
  const leadPrompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      await writeFile(join(options.cwd, file), "work\n");
      return { exitCode: 0, finalText: "상태: 완료" };
    }
    leadPrompts.push(options.prompt);
    return { exitCode: 0, finalText: options.prompt.includes("사용자 요청:\n준비") ? "준비" : `<<DELEGATE to="claude">>${file} 만들기<</DELEGATE>>` };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo, steward: { name: "앱" } });
  await waitFor(() => chat.status === "done");
  return { repo, dataDir, orchestra, chat, leadPrompts };
}

test("a lead chat saved before leads were entities gets one on load, keeping its notes, team and merging", async (t) => {
  const { repo, dataDir } = await setup(t);
  const legacy = {
    id: "old-lead", title: "옛 담당", agent: "codex", workers: ["claude"], cwd: repo, status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [],
    workspaceId: "personal", skills: ["review"], systemPrompt: "한국어로 답해", model: "gpt-5", workerConfigs: [{ id: "claude", agent: "claude", model: "opus" }],
    steward: { turns: 3, since: "2026-01-01T00:00:00.000Z", name: "옛것", report: "08:00" },
  } as unknown as Session;
  await saveNotes(dataDir, legacy.id, "- 결정: 옛 노트");
  const saved: Steward[][] = [];
  const prompts: string[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => { prompts.push(options.prompt); return { exitCode: 0, finalText: "네" }; });
  orchestra.stewardDataDir = dataDir;
  orchestra.persistStewards = (list) => { saved.push(structuredClone(list)); };
  orchestra.restore([legacy]);
  const steward = orchestra.getSteward("old-lead")!;
  assert.ok(steward, "the entity takes the chat's id, so its notes stay where they are");
  assert.equal(legacy.steward!.id, "old-lead");
  assert.equal(steward.name, "옛것");
  assert.equal(steward.systemPrompt, "한국어로 답해");
  assert.deepEqual(steward.skills, ["review"]);
  assert.equal(steward.agent, "codex");
  assert.equal(steward.model, "gpt-5");
  assert.deepEqual(steward.workers, [{ id: "claude", label: "Claude", agent: "claude", model: "opus" }]);
  assert.equal(steward.mergePolicy, "auto", "a lead that merged every turn keeps doing so");
  assert.deepEqual(steward.cwds, [repo]);
  assert.equal(steward.report, "08:00", "the chat's report time is now its lead's");
  assert.equal(legacy.steward!.report, undefined);
  assert.equal(legacy.steward!.turns, 3, "nothing else on the chat changes");
  assert.equal(saved.length, 1, "the new entity is written");
  await orchestra.followup(legacy.id, "이어서");
  await waitFor(() => legacy.status === "done");
  assert.match(prompts[0], /결정: 옛 노트/u, "the old notes still come with the turn");
  assert.match(prompts[0], /한국어로 답해/u);

  // Loaded again with its entity: nothing more is made.
  const again = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "네" }));
  again.persistStewards = () => { throw new Error("no write expected"); };
  again.restore([structuredClone(legacy)], saved[0]);
  assert.equal(again.listStewards().length, 1);
});

test("mergePolicy ask holds the branches until the user approves, and a rejection keeps them", async (t) => {
  const { repo, orchestra, chat } = await leadWithWorker(t);
  assert.equal(orchestra.stewardOf(chat)!.mergePolicy, "ask", "new leads ask by default");
  await orchestra.followup(chat.id, "만들어");
  await waitFor(() => chat.status === "done" && Boolean(chat.steward!.pendingMerge), 10_000);
  await assert.rejects(readFile(join(repo, "work.txt"), "utf8"), "nothing in the main checkout yet");
  assert.equal(chat.steward!.pendingMerge!.branches.length, 1);
  assert.ok(chat.events.some((event) => event.metadata?.mergeHold === "ask"), "the user is told, and notified");

  orchestra.rejectMerge(chat.id);
  assert.equal(chat.steward!.pendingMerge, undefined);
  assert.equal(chat.worktrees?.length, 1, "a rejected branch stays");
  assert.match(chat.steward!.appNotes!.join("\n"), /거절/u, "the lead hears about it next turn");
  await assert.rejects(orchestra.approveMerge(chat.id), /기다리는 작업이 없습니다/u);

  await orchestra.followup(chat.id, "다시");
  await waitFor(() => chat.status === "done" && Boolean(chat.steward!.pendingMerge), 10_000);
  await orchestra.approveMerge(chat.id);
  assert.equal(await readFile(join(repo, "work.txt"), "utf8"), "work\n", "approved: merged into the main checkout");
  assert.equal(chat.steward!.pendingMerge, undefined);
  assert.equal(chat.worktrees, undefined);
  assert.ok(chat.events.some((event) => event.text.startsWith("사용자가 승인해 이번 턴의 작업을 메인 폴더에 병합했습니다")));
});

test("mergePolicy never leaves the work on its branch and says so", async (t) => {
  const { repo, orchestra, chat, leadPrompts } = await leadWithWorker(t);
  orchestra.patchSteward(chat.steward!.id!, { mergePolicy: "never" });
  await orchestra.followup(chat.id, "만들어");
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.metadata?.mergeHold === "never"), 10_000);
  await assert.rejects(readFile(join(repo, "work.txt"), "utf8"));
  assert.equal(chat.steward!.pendingMerge, undefined, "nothing waits for approval");
  assert.equal(chat.worktrees?.length, 1, "the branch is kept");
  assert.ok(leadPrompts.at(-1)!.includes(mergeRule("never")), "the lead is told the app does not merge");
});

test("the merge rule the lead reads follows its policy", () => {
  assert.match(stewardRules("", "/t", [], [], { mergePolicy: "auto" }), /턴이 끝날 때 앱이 메인 폴더에 병합합니다/u);
  assert.match(stewardRules("", "/t", [], [], { mergePolicy: "ask" }), /사용자가 승인할 때까지/u);
  assert.match(stewardRules("", "/t", [], [], { mergePolicy: "never" }), /병합하지 않습니다/u);
  assert.doesNotMatch(stewardRules("", "/t", [], [], { mergePolicy: "never" }), /턴이 끝날 때 앱이 메인 폴더에 병합합니다/u);
});

test("a lead's instructions and skills changed after its chat began apply from the next turn", async (t) => {
  const { orchestra, chat, leadPrompts } = await leadWithWorker(t);
  assert.doesNotMatch(leadPrompts[0], /항상 존댓말/u);
  orchestra.patchSteward(chat.steward!.id!, { systemPrompt: "항상 존댓말로 답하세요." });
  await orchestra.followup(chat.id, "준비");
  await waitFor(() => chat.status === "done" && leadPrompts.length === 2);
  assert.match(leadPrompts[1], /^항상 존댓말로 답하세요\./u);
  orchestra.patchSteward(chat.steward!.id!, { skills: ["review"] });
  assert.deepEqual(orchestra.summary(chat.id).steward?.skills, ["review"], "the thread reads the lead's skills, not the ones it began with");
});

test("the user's common preferences come with every lead turn, next to the notes", async (t) => {
  const { dataDir, orchestra, chat, leadPrompts } = await leadWithWorker(t);
  await saveUserPreferences(dataDir, "- 커밋 메시지는 영어로\n- 테스트 먼저");
  await orchestra.followup(chat.id, "준비");
  await waitFor(() => chat.status === "done" && leadPrompts.length === 2);
  assert.match(leadPrompts[1], /### 사용자 공통 선호[\s\S]*커밋 메시지는 영어로[\s\S]*테스트 먼저/u);
  assert.doesNotMatch(leadPrompts[0], /사용자 공통 선호/u, "nothing is added while the file is empty");
});

test("a lead hands work to an allowed CLI its team lacks, and is refused one the workspace forbids", async (t) => {
  const { repo, dataDir } = await setup(t);
  const workerAgents: string[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") { workerAgents.push(options.agent); return { exitCode: 0, finalText: "상태: 완료" }; }
    if (options.prompt.includes("사용자 요청:\n클로드로 해")) return { exitCode: 0, finalText: '<<DELEGATE to="claude">>확인<</DELEGATE>>' };
    if (options.prompt.includes("사용자 요청:\n그록으로 해")) return { exitCode: 0, finalText: '<<DELEGATE to="grok">>확인<</DELEGATE>>' };
    return { exitCode: 0, finalText: "준비" };
  };
  const orchestra = new Orchestra(undefined, runner, undefined, undefined, undefined, () => ["codex", "claude"]);
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["codex"], cwd: repo, steward: {} });
  await waitFor(() => chat.status === "done");
  await orchestra.followup(chat.id, "클로드로 해");
  await waitFor(() => chat.status === "done" && workerAgents.length === 1);
  assert.deepEqual(workerAgents, ["claude"], "the claude worker ran");
  assert.deepEqual(chat.workers, ["codex", "claude"], "and stays on the team");
  assert.ok(chat.events.some((event) => event.metadata?.addedWorker === "claude"), "the user is told");

  await orchestra.followup(chat.id, "그록으로 해");
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.type === "warning" && event.text.includes("허용되지 않은 에이전트")));
  assert.deepEqual(workerAgents, ["claude"], "no grok worker ran");
  assert.deepEqual(chat.workers, ["codex", "claude"]);
});

test("the rollover gives the lead a fresh CLI session but keeps the workers' sessions", async (t) => {
  const { repo, dataDir } = await setup(t);
  const workerResumes: (string | undefined)[] = [];
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") { workerResumes.push(options.resumeSessionId); return { exitCode: 0, sessionId: "worker-cli", finalText: "상태: 완료" }; }
    return { exitCode: 0, sessionId: "lead-cli", finalText: options.prompt.includes("사용자 요청:\n준비") ? "준비" : '<<DELEGATE to="claude">>일<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.stewardDataDir = dataDir;
  const chat = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo, steward: {} });
  await waitFor(() => chat.status === "done");
  chat.steward!.turns = STEWARD_ROLLOVER_TURNS - 1;
  await orchestra.followup(chat.id, "일해");
  await waitFor(() => chat.status === "done" && chat.events.some((event) => event.text.includes("새 세션으로 이어 갑니다")));
  assert.equal(chat.cliSessionId, undefined, "the lead starts fresh");
  assert.deepEqual(chat.workerSessionIds, { claude: "worker-cli" }, "the worker keeps its session");
  await orchestra.followup(chat.id, "또 일해");
  await waitFor(() => chat.status === "done" && workerResumes.length === 2);
  assert.equal(workerResumes[1], "worker-cli", "the next delegation resumes it");
});

test("a chat's summary has its status, the lead's last answer without app blocks, its checklist and a waiting merge", async (t) => {
  const { orchestra, chat } = await leadWithWorker(t);
  await orchestra.followup(chat.id, "만들어");
  await waitFor(() => chat.status === "done" && Boolean(chat.steward!.pendingMerge), 10_000);
  const summary = orchestra.summary(chat.id);
  assert.equal(summary.status, "done");
  assert.equal(summary.pendingMerge?.branches.length, 1);
  assert.equal(summary.steward?.name, "앱");
  assert.equal(summary.steward?.mergePolicy, "ask");
  assert.throws(() => orchestra.summary("missing"), /세션을 찾을 수 없습니다/u);

  const pure = sessionSummary({
    id: "s", title: "t", status: "running", cwd: "/w", agent: "codex", workers: [], createdAt: "", workspaceId: "w",
    goal: { items: [{ text: "a", status: "done" }], startedAt: "", autoTurns: 0, idleTurns: 0 },
    events: [
      { id: "1", sessionId: "s", agent: "codex", type: "message", role: "orchestrator", text: "답입니다\n<<NOTES>>\n- x\n<</NOTES>>", time: "" },
      { id: "2", sessionId: "s", agent: "claude", type: "message", role: "worker", text: "워커 보고", time: "" },
    ],
  } as Session);
  assert.equal(pure.lastAnswer, "답입니다");
  assert.deepEqual(pure.checklist, [{ text: "a", status: "done" }]);
  assert.equal(pure.steward, null);
  assert.equal(pure.pendingMerge, null);
});

test("a new thread of a lead runs with the lead's team and shares its notes", async (t) => {
  const { repo, dataDir } = await setup(t);
  const leads: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => { leads.push(options); return { exitCode: 0, finalText: "네" }; });
  orchestra.stewardDataDir = dataDir;
  const steward = orchestra.createSteward({ name: "백엔드", agent: "claude", systemPrompt: "백엔드 담당입니다.", workers: [{ agent: "codex", model: "gpt-5" }], cwds: [repo] });
  assert.equal(steward.mergePolicy, "ask");
  assert.deepEqual(steward.workers, [{ id: "codex", label: "Codex", agent: "codex", model: "gpt-5" }]);
  assert.throws(() => orchestra.createSteward({ name: "백엔드" }), /이미 「백엔드」/u);
  await saveNotes(dataDir, steward.id, "- 공유 노트");
  const thread = await orchestra.create({ prompt: "시작", agent: "codex", workers: ["claude"], cwd: repo, steward: { id: steward.id } });
  await waitFor(() => thread.status === "done");
  assert.equal(thread.agent, "claude");
  assert.deepEqual(thread.workers, ["codex"]);
  assert.equal(thread.steward!.name, "백엔드");
  assert.match(leads[0].prompt, /^백엔드 담당입니다\./u);
  assert.match(leads[0].prompt, /공유 노트/u);
  await assert.rejects(orchestra.create({ prompt: "x", agent: "codex", workers: ["claude"], cwd: repo, steward: { id: "nope" } }), /담당을 찾을 수 없습니다/u);

  const plain = await orchestra.create({ prompt: "준비", agent: "codex", workers: ["claude"], cwd: repo });
  await waitFor(() => plain.status === "done");
  orchestra.setSteward(plain.id, true);
  orchestra.patchSteward(plain.id, { mergePolicy: "never", systemPrompt: "고친 지침" });
  orchestra.setSteward(plain.id, false);
  orchestra.setSteward(plain.id, true);
  assert.equal(orchestra.getSteward(plain.id)!.mergePolicy, "never", "made a lead again: its edited entity comes back");
  assert.equal(orchestra.getSteward(plain.id)!.systemPrompt, "고친 지침");

  orchestra.patchSteward(steward.id, { name: "서버" });
  assert.equal(thread.steward!.name, "서버", "a new name shows in every thread");
  await orchestra.deleteSteward(steward.id);
  assert.equal(thread.steward, undefined, "its chats stay, as ordinary chats");
  assert.equal(orchestra.getSteward(steward.id), undefined);
  assert.equal(stewardFromSession({ ...thread, steward: { turns: 0, since: "" } } as Session).name.length > 0, true);
});

// --- Migrated leads' merge policy: the legacy default, the app-wide setting and the one-click change ---

const legacyChat = (id: string, cwd: string) => ({
  id, title: "옛 담당", agent: "codex", workers: ["claude"], cwd, status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [],
  workspaceId: "personal", steward: { turns: 1, since: "2026-01-01T00:00:00.000Z", name: id },
}) as unknown as Session;

test("migrated leads keep merging by default, or ask when the user chose so for them", async (t) => {
  const { repo } = await setup(t);
  const kept = new Orchestra();
  kept.restore([legacyChat("a", repo)]);
  assert.equal(kept.getSteward("a")!.mergePolicy, "auto");
  assert.equal(kept.getSteward("a")!.migrated, true);
  const asking = new Orchestra();
  asking.restore([legacyChat("a", repo)], [], { legacyMergePolicy: "ask" });
  assert.equal(asking.getSteward("a")!.mergePolicy, "ask");
});

test("the legacy setting moves migrated leads nobody set by hand; the one-click change moves every lead", async (t) => {
  const { repo } = await setup(t);
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "네" }));
  const writes: Steward[][] = [];
  orchestra.persistStewards = (list) => { writes.push(list); };
  orchestra.restore([legacyChat("a", repo), legacyChat("b", repo)]);
  const fresh = orchestra.createSteward({ name: "새것" });
  orchestra.patchSteward("b", { mergePolicy: "never" });
  assert.equal(orchestra.getSteward("b")!.mergePolicyChosen, true);
  assert.equal(orchestra.setLegacyMergePolicy("ask"), 1);
  assert.equal(orchestra.getSteward("a")!.mergePolicy, "ask", "a migrated lead on the default follows the setting");
  assert.equal(orchestra.getSteward("b")!.mergePolicy, "never", "a policy picked by hand stays");
  assert.equal(orchestra.getSteward(fresh.id)!.mergePolicy, "ask", "a new lead is not a migrated one");
  assert.equal(orchestra.setLegacyMergePolicy("auto"), 1);
  assert.equal(orchestra.getSteward("a")!.mergePolicy, "auto");

  const before = writes.length;
  assert.equal(orchestra.setAllMergePolicies("never"), 2, "two leads were not on never yet");
  assert.deepEqual(orchestra.listStewards().map((item) => item.mergePolicy), ["never", "never", "never"]);
  assert.ok(writes.length > before, "the change is written");
  assert.equal(orchestra.setLegacyMergePolicy("ask"), 0, "after the one-click change every policy counts as chosen");
});

test("a migrated lead's own merge policy, picked in its panel, decides its next turn", async (t) => {
  const { repo, dataDir } = await setup(t);
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") { await writeFile(join(options.cwd, "legacy.txt"), "x\n"); return { exitCode: 0, finalText: "상태: 완료" }; }
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>legacy.txt 만들기<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  orchestra.stewardDataDir = dataDir;
  const chat = legacyChat("legacy", repo);
  orchestra.restore([chat]);
  assert.equal(orchestra.getSteward("legacy")!.mergePolicy, "auto");
  orchestra.patchSteward("legacy", { mergePolicy: "ask" });
  await orchestra.followup(chat.id, "만들어");
  await waitFor(() => chat.status === "done" && Boolean(chat.steward!.pendingMerge), 10_000);
  await assert.rejects(readFile(join(repo, "legacy.txt"), "utf8"), "ask: not merged without approval");
  await orchestra.approveMerge(chat.id);
  assert.equal(await readFile(join(repo, "legacy.txt"), "utf8"), "x\n");
});

// --- A new chat picked from the lead list, and reports per lead --------------------------------

test("a chat started from the lead picker takes the lead's folder, team, instructions, skills and merge policy", async (t) => {
  const { repo, dataDir } = await setup(t);
  const prompts: RunCliOptions[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => { prompts.push(options); return { exitCode: 0, finalText: "네" }; });
  orchestra.stewardDataDir = dataDir;
  const steward = orchestra.createSteward({ name: "웹", agent: "grok", systemPrompt: "웹 담당입니다.\n둘째 줄", skills: ["review"], workers: [{ agent: "claude" }], mergePolicy: "never", cwds: [repo] });
  // What the picker sends: the lead's id, and no folder of its own.
  const chat = await orchestra.create({ prompt: "시작", agent: "codex", workers: ["codex"], cwd: "", steward: { id: steward.id } });
  await waitFor(() => chat.status === "done");
  assert.equal(chat.cwd, repo, "the lead's first folder");
  assert.equal(chat.agent, "grok");
  assert.deepEqual(chat.workers, ["claude"]);
  assert.deepEqual(chat.skills, [], "default preferences are not selected attachments");
  assert.equal(chat.steward!.id, steward.id, "the chat says which lead it belongs to");
  assert.equal(orchestra.stewardOf(chat)!.mergePolicy, "never");
  assert.match(prompts[0].prompt, /^웹 담당입니다\./u);
  assert.match(prompts[0].prompt, /앱은 워커 브랜치를 메인 폴더에 병합하지 않습니다/u);
  const empty = orchestra.createSteward({ name: "폴더 없음" });
  await assert.rejects(orchestra.create({ prompt: "x", agent: "codex", workers: ["codex"], cwd: "", steward: { id: empty.id } }), /작업 폴더가 올바르지 않습니다/u);
});

test("chats' report times become their lead's: the earliest time, the latest report", () => {
  assert.deepEqual(mergeThreadReports([
    { report: "09:00", reportedAt: "2026-11-01T00:00:00.000Z", reportState: "old" },
    { report: "08:30", reportedAt: "2026-11-02T00:00:00.000Z", reportState: "new" },
    { report: "09:00" },
  ]), { report: "08:30", reportedAt: "2026-11-02T00:00:00.000Z", reportState: "new", times: ["08:30", "09:00"] });
  assert.deepEqual(mergeThreadReports([{}]), { times: [] });
});

test("on load, a lead's chats with different report times leave it the earliest, and the latest chat says so", async (t) => {
  const { repo } = await setup(t);
  const chat = (id: string, report: string, last: string, reportedAt?: string) => ({
    id, title: id, agent: "codex", workers: ["claude"], cwd: repo, status: "done", createdAt: "2026-01-01T00:00:00.000Z", workspaceId: "personal",
    events: [{ id: `${id}-e`, sessionId: id, agent: "user", type: "message", text: "hi", time: last }],
    steward: { id: "L", turns: 1, since: "", name: "앱", report, ...(reportedAt ? { reportedAt } : {}) },
  }) as unknown as Session;
  const lead: Steward = { id: "L", name: "앱", agent: "codex", skills: [], systemPrompt: "", workers: [{ agent: "claude" }], mergePolicy: "auto", cwds: [repo], createdAt: "2026-01-01T00:00:00.000Z" };
  const older = chat("older", "09:00", "2026-03-01T00:00:00.000Z", "2026-11-02T09:00:00.000Z");
  const newer = chat("newer", "07:30", "2026-04-01T00:00:00.000Z");
  const writes: Steward[][] = [];
  const orchestra = new Orchestra();
  orchestra.persistStewards = (list) => { writes.push(structuredClone(list)); };
  orchestra.restore([older, newer], [lead]);
  const moved = orchestra.getSteward("L")!;
  assert.equal(moved.report, "07:30", "the earliest of the chats' times");
  assert.equal(moved.reportedAt, "2026-11-02T09:00:00.000Z", "the last report counts, so nothing reports twice");
  assert.equal(older.steward!.report, undefined);
  assert.equal(newer.steward!.report, undefined);
  assert.match(newer.events.at(-1)!.text, /07:30, 09:00[\s\S]*가장 이른 07:30/u, "the lead's latest chat tells the user");
  assert.equal(older.events.length, 1);
  assert.equal(writes.length, 1, "the lead is saved with its report");
  // Loaded again: nothing is left to move.
  const again = new Orchestra();
  again.restore([structuredClone(older), structuredClone(newer)], writes[0]);
  assert.equal(again.getSteward("L")!.report, "07:30");
});

test("a lead with several chats reports once a day, in the chat it used last, covering the others", async (t) => {
  const { repo, dataDir } = await setup(t);
  const prompts: { session: string; prompt: string }[] = [];
  const orchestra = new Orchestra(undefined, async (options: RunCliOptions) => { prompts.push({ session: options.usageContext?.sessionId ?? "", prompt: options.prompt }); return { exitCode: 0, finalText: "보고" }; });
  orchestra.stewardDataDir = dataDir;
  const steward = orchestra.createSteward({ name: "보고", workers: [{ agent: "claude" }], cwds: [repo] });
  const first = await orchestra.create({ prompt: "첫 채팅", agent: "codex", workers: ["claude"], cwd: repo, steward: { id: steward.id } });
  await waitFor(() => first.status === "done");
  const second = await orchestra.create({ prompt: "둘째 채팅", agent: "codex", workers: ["claude"], cwd: repo, steward: { id: steward.id } });
  await waitFor(() => second.status === "done");
  orchestra.updateSteward(first.id, { report: "00:00" });
  assert.equal(orchestra.getSteward(steward.id)!.report, "00:00", "the old per-chat API sets the lead's report");
  assert.equal(first.steward!.report, undefined);
  const before = prompts.length;
  await orchestra.stewardTick(new Date(Date.now() + 86_400_000));
  await waitFor(() => second.status === "done" && prompts.length === before + 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(prompts.length, before + 1, "one report for the lead, not one per chat");
  const report = prompts.at(-1)!;
  assert.match(report.prompt, /정기 보고/u);
  assert.match(report.prompt, /다른 채팅도 함께 보고[\s\S]*「첫 채팅」/u, "it covers the lead's other chat");
  assert.ok(second.events.some((event) => event.text.startsWith("[앱 — 정기 보고]")), "it opens in the chat used last");
  assert.ok(!first.events.some((event) => event.text.startsWith("[앱 — 정기 보고]")));
  await orchestra.stewardTick(new Date(Date.now() + 86_400_000 + 60_000));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(prompts.length, before + 1, "once a day");
  orchestra.setStewardReport(steward.id, null);
  assert.equal(orchestra.getSteward(steward.id)!.report, undefined);
});

test("a Grok lead opens a chat in its project and a lead for another folder when the user asks", async (t) => {
  const a = await setup(t, "app");
  const b = await setup(t, "api");
  const prompts: string[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push(options.prompt);
    if (options.prompt.includes("사용자 요청:\n결제 채팅 열고 api 담당도 만들어")) {
      return { exitCode: 0, finalText: `만들겠습니다.\n<<NEW_CHAT title="결제 화면">>\n결제 화면을 점검해 주세요.\n<</NEW_CHAT>>\n<<NEW_LEAD name="api 담당" cwd="${b.repo}">>\n서버 저장소를 맡습니다.\n<</NEW_LEAD>>\n<<NEW_LEAD name="없는 폴더" cwd="/no/such/folder-sinawi">><</NEW_LEAD>>` };
    }
    // The opened thread tries to open more: the app refuses.
    if (options.prompt.includes("사용자 요청:\n결제 화면을 점검해 주세요.")) return { exitCode: 0, finalText: "점검했습니다.\n<<NEW_CHAT>>또 열기<</NEW_CHAT>>" };
    return { exitCode: 0, finalText: "준비했습니다." };
  };
  const orchestra = new Orchestra(undefined, runner);
  orchestra.worktreeDataDir = a.dataDir;
  orchestra.stewardDataDir = a.dataDir;
  const lead = await orchestra.create({ prompt: "준비", agent: "grok", workers: ["claude"], cwd: a.repo, steward: {} });
  await waitFor(() => lead.status === "done");
  assert.match(prompts[0], /<<NEW_CHAT title=/u, "a Grok lead is told the tags");
  const before = orchestra.list().length;
  await orchestra.followup(lead.id, "결제 채팅 열고 api 담당도 만들어");
  await waitFor(() => orchestra.list().length === before + 1);
  const opened = orchestra.list().find((session) => session.title === "결제 화면")!;
  assert.equal(opened.steward?.id, lead.steward?.id ?? lead.id, "the new chat is a thread of the same lead");
  assert.equal(opened.cwd, a.repo);
  await waitFor(() => opened.status === "done" && lead.status === "done");
  assert.ok(orchestra.listStewards().some((steward) => steward.name === "api 담당" && steward.cwds[0] === b.repo && steward.systemPrompt === "서버 저장소를 맡습니다."));
  assert.ok(lead.events.some((event) => event.type === "status" && /새 채팅을 열었습니다/u.test(event.text)));
  assert.ok(lead.events.some((event) => event.type === "warning" && /없는 폴더/u.test(event.text)));
  // Blocks are not shown as chat text, and a thread a lead opened opens nothing more.
  await waitFor(() => opened.events.some((event) => event.type === "warning" && /만들 수 없습니다/u.test(event.text)));
  assert.equal(orchestra.list().length, before + 1);
  assert.deepEqual(parseLeadCreates('<<NEW_CHAT>>\n할 일\n<</NEW_CHAT>> <<NEW_LEAD name="x" cwd="/a/b">><</NEW_LEAD>>'), { chats: [{ prompt: "할 일" }], leads: [{ name: "x", cwd: "/a/b", instructions: "" }] });
  // A lead with the app's tools (Claude, Codex) gets the tool guide instead of the tags.
  assert.doesNotMatch(stewardRules("", "/t"), /NEW_CHAT/u);
});
