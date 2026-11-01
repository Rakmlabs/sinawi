import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import type { Session } from "./types.js";
import { cleanupSessionWorktrees, ensureWorkerWorktree, pruneEmptyWorktrees, removeWorktree, worktreeReviewNote, worktreeStatus, WorktreeDirtyError } from "./worktrees.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function tempRepo(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-wt-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const dataDir = join(base, "data");
  await mkdir(join(repo, "app"), { recursive: true });
  git(base, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "app", "index.txt"), "one\n");
  await writeFile(join(repo, "README.md"), "readme\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return { base, repo, dataDir };
}

test("non-git folders get no worktree", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sinawi-nogit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal(await ensureWorkerWorktree({ dataDir: join(base, "data"), sessionId: "abcdef12-0000", workerId: "claude", cwd: base }), undefined);
});

test("each worker gets its own branch and folder outside the repo, based on HEAD", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  await writeFile(join(repo, "README.md"), "dirty main\n");
  const sessionId = "abcdef12-3456";
  const first = (await ensureWorkerWorktree({ dataDir, sessionId, workerId: "claude", workerLabel: "Claude", cwd: join(repo, "app") }))!;
  const second = (await ensureWorkerWorktree({ dataDir, sessionId, workerId: "grok", cwd: join(repo, "app") }))!;
  assert.equal(first.branch, "sinawi/abcdef12/claude");
  assert.equal(second.branch, "sinawi/abcdef12/grok");
  assert.notEqual(first.path, second.path);
  assert.ok(first.path.startsWith(join(dataDir, "worktrees")), "worktrees live in the data dir, not in the repo");
  assert.equal(first.cwd, join(first.path, "app"), "the worker runs in the session subfolder's counterpart");
  assert.equal(first.mainDirty, true);
  // HEAD content, not the dirty main tree.
  assert.equal(await readFile(join(first.path, "README.md"), "utf8"), "readme\n");
  assert.equal(git(repo, "status", "--porcelain"), "M README.md", "the main tree is untouched apart from the user's own edit");

  // Reused on the next round.
  const again = (await ensureWorkerWorktree({ dataDir, sessionId, workerId: "claude", cwd: join(repo, "app"), existing: first }))!;
  assert.equal(again.path, first.path);

  await writeFile(join(first.cwd, "index.txt"), "two\n");
  await writeFile(join(first.cwd, "new.txt"), "new\n");
  const status = await worktreeStatus(first);
  assert.equal(status.exists, true);
  assert.equal(status.changedFiles, 2);
  assert.equal(status.uncommitted, 2);
  assert.equal(status.commits, 0);
  assert.deepEqual(status.files, ["app/index.txt", "app/new.txt"]);
  assert.match(status.mergeCommand, /add -A && git -C .* commit -m .* && git -C .* merge --no-ff sinawi\/abcdef12\/claude$/);

  const note = await worktreeReviewNote([first, second]);
  assert.match(note, /sinawi\/abcdef12\/claude/);
  assert.match(note, /바뀐 파일 2개/);
  assert.match(note, /app\/new\.txt/);
  assert.match(note, /메인 폴더에 커밋되지 않은 변경/);

  await assert.rejects(removeWorktree(first), WorktreeDirtyError, "uncommitted changes need confirmation");
  assert.ok((await stat(first.path)).isDirectory());

  // Committed work: the folder can go, the branch stays.
  git(first.path, "add", "-A");
  git(first.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
  const committed = await worktreeStatus(first);
  assert.equal(committed.commits, 1);
  assert.equal(committed.uncommitted, 0);
  assert.equal(committed.mergeCommand, `git -C ${repo} merge --no-ff sinawi/abcdef12/claude`);
  assert.deepEqual(await removeWorktree(first), { branchKept: true, commits: 1 });
  assert.ok(git(repo, "branch", "--list", "sinawi/abcdef12/claude"));
  await assert.rejects(stat(first.path));

  // The kept branch is checked out again for the next run.
  const restored = (await ensureWorkerWorktree({ dataDir, sessionId, workerId: "claude", cwd: join(repo, "app"), existing: first }))!;
  assert.equal(await readFile(join(restored.cwd, "new.txt"), "utf8"), "new\n");
  assert.equal(restored.base, first.base);

  // An empty worktree (no change, no commit) is pruned with its branch.
  const kept = await pruneEmptyWorktrees([restored, second]);
  assert.deepEqual(kept.map((item) => item.workerId), ["claude"]);
  assert.equal(git(repo, "branch", "--list", "sinawi/abcdef12/grok"), "");
});

test("forced removal discards uncommitted changes; session cleanup keeps dirty worktrees", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const a = (await ensureWorkerWorktree({ dataDir, sessionId: "11112222-x", workerId: "codex", cwd: repo }))!;
  const b = (await ensureWorkerWorktree({ dataDir, sessionId: "11112222-x", workerId: "claude", cwd: repo }))!;
  await writeFile(join(a.path, "x.txt"), "x");
  await writeFile(join(b.path, "y.txt"), "y");
  const cleanup = await cleanupSessionWorktrees([a]);
  assert.deepEqual(cleanup.kept.map((item) => item.reason), ["uncommitted"]);
  assert.ok((await stat(a.path)).isDirectory());
  assert.deepEqual(await removeWorktree(b, { force: true }), { branchKept: false, commits: 0 });
  await assert.rejects(stat(b.path));
});

async function settle(session: Session, timeoutMs = 10_000) {
  const started = Date.now();
  while (session.status === "running") {
    if (Date.now() - started > timeoutMs) throw new Error("session did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("workers run in separate worktrees and the lead's review is told where the changes are", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const calls: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    calls.push(options);
    let text = "";
    if (calls.length === 1) text = '<<DELEGATE to="claude">>write a.txt<</DELEGATE>>\n<<DELEGATE to="grok">>write b.txt<</DELEGATE>>';
    else if (options.readOnly) text = "verified: branches sinawi/…/claude and sinawi/…/grok";
    else {
      await writeFile(join(options.cwd, options.agent === "claude" ? "a.txt" : "b.txt"), options.agent);
      text = "done";
    }
    options.onLine({ type: "message", text, finalText: text });
    return { exitCode: 0, finalText: text };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const session = await orchestra.create({ prompt: "two files", agent: "claude", workers: ["claude", "grok"], cwd: repo });
  await settle(session);
  assert.equal(session.status, "done");
  const [lead, claude, grok, review] = calls;
  assert.match(lead.prompt, /전용 git worktree와 브랜치/);
  assert.equal(lead.cwd, repo);
  assert.notEqual(claude.cwd, repo);
  assert.notEqual(grok.cwd, repo);
  assert.notEqual(claude.cwd, grok.cwd);
  assert.match(claude.prompt, /작업 위치 \(git worktree\)/);
  assert.equal(review.readOnly, true);
  assert.equal(review.cwd, repo);
  assert.deepEqual(new Set(review.extraDirs), new Set([claude.cwd, grok.cwd]));
  assert.match(review.prompt, /워커 변경 위치 \(git worktree\)/);
  assert.match(review.prompt, new RegExp(`sinawi/${session.id.slice(0, 8)}/claude`));
  assert.match(review.prompt, /a\.txt/);
  assert.equal(git(repo, "status", "--porcelain"), "", "the main tree never changed");
  assert.equal(session.worktrees?.length, 2);
  assert.ok(session.events.some((event) => event.type === "status" && /^작업 브랜치 sinawi\//.test(event.text)));
});

test("byte-identical copies of main-tree untracked files (e.g. .omc/) are not worker work and stay out of the merge", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  await mkdir(join(repo, ".omc"), { recursive: true });
  await writeFile(join(repo, ".omc", "state.json"), "{}");
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "33334444-x", workerId: "claude", cwd: repo }))!;
  await mkdir(join(info.path, ".omc"), { recursive: true });
  await writeFile(join(info.path, ".omc", "state.json"), "{}");
  assert.equal((await worktreeStatus(info)).changedFiles, 0, "noise only");
  await writeFile(join(info.path, "hello.txt"), "hello\n");
  const status = await worktreeStatus(info);
  assert.deepEqual(status.files, ["hello.txt"]);
  // The copied command commits the work without the noise, and the merge succeeds on the main tree.
  execFileSync("/bin/sh", ["-c", status.mergeCommand], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_MERGE_AUTOEDIT: "no" }, stdio: "pipe" });
  assert.equal(await readFile(join(repo, "hello.txt"), "utf8"), "hello\n");
  assert.equal(git(repo, "ls-files", ".omc"), "");
  // Only noise left: removal needs no confirmation; the merged branch has commits so it is kept.
  assert.deepEqual(await removeWorktree(info), { branchKept: true, commits: 1 });
});

test("new worker files under a folder the main tree has untracked are work, and auto-prune keeps them", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  await mkdir(join(repo, "src", "feature"), { recursive: true });
  await writeFile(join(repo, "src", "feature", "draft.ts"), "main draft\n");
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "55556666-x", workerId: "claude", cwd: repo }))!;
  await mkdir(join(info.path, "src", "feature"), { recursive: true });
  await writeFile(join(info.path, "src", "feature", "worker.ts"), "export const work = 1;\n");
  // Same path as a main-tree file but different bytes: also the worker's.
  await writeFile(join(info.path, "src", "feature", "draft.ts"), "worker draft\n");
  const status = await worktreeStatus(info);
  assert.deepEqual(status.files, ["src/feature/draft.ts", "src/feature/worker.ts"]);
  assert.equal(status.uncommitted, 2);
  assert.deepEqual((await pruneEmptyWorktrees([info])).map((item) => item.workerId), ["claude"]);
  assert.equal(await readFile(join(info.path, "src", "feature", "worker.ts"), "utf8"), "export const work = 1;\n");
});

test("a git failure while checking keeps the worktree instead of reporting it empty", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "77778888-x", workerId: "claude", cwd: repo }))!;
  await writeFile(join(info.path, "work.txt"), "work\n");
  // A base git cannot resolve makes `git diff`/`rev-list` fail.
  const broken = { ...info, base: "0".repeat(40) };
  await assert.rejects(worktreeStatus(broken));
  assert.deepEqual((await pruneEmptyWorktrees([broken])).map((item) => item.workerId), ["claude"]);
  assert.equal(await readFile(join(info.path, "work.txt"), "utf8"), "work\n");
  // A folder git does not recognise as a worktree also fails the check rather than reading as empty.
  await rm(join(info.path, ".git"));
  await assert.rejects(worktreeStatus(info));
  assert.equal((await pruneEmptyWorktrees([info])).length, 1);
  assert.ok((await stat(join(info.path, "work.txt"))).isFile());
});

test("auto-prune removes a clean empty worktree, but never forces one git would refuse", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const clean = (await ensureWorkerWorktree({ dataDir, sessionId: "9999aaaa-x", workerId: "codex", cwd: repo }))!;
  assert.deepEqual(await pruneEmptyWorktrees([clean]), []);
  await assert.rejects(stat(clean.path));
  assert.equal(git(repo, "branch", "--list", clean.branch), "");

  // Only an identical copy of a main-tree untracked file: counted as empty, but a plain
  // `git worktree remove` refuses untracked files, so the folder stays.
  await writeFile(join(repo, "notes.local"), "mine\n");
  const copy = (await ensureWorkerWorktree({ dataDir, sessionId: "9999aaaa-x", workerId: "grok", cwd: repo }))!;
  await writeFile(join(copy.path, "notes.local"), "mine\n");
  assert.equal((await worktreeStatus(copy)).changedFiles, 0);
  assert.deepEqual((await pruneEmptyWorktrees([copy])).map((item) => item.workerId), ["grok"]);
  assert.ok((await stat(copy.path)).isDirectory());

  // The veto is asked right before deleting.
  const vetoed = (await ensureWorkerWorktree({ dataDir, sessionId: "9999aaaa-x", workerId: "claude", cwd: repo }))!;
  assert.equal((await pruneEmptyWorktrees([vetoed], { canRemove: () => false })).length, 1);
  assert.ok((await stat(vetoed.path)).isDirectory());
});

test("an aborted worker that writes after SIGTERM keeps its worktree: pruning waits for the process to exit", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  let workerStarted!: () => void;
  const started = new Promise<void>((resolve) => { workerStarted = resolve; });
  const runner = async (options: RunCliOptions) => {
    if (!options.cwd.startsWith(dataDir)) {
      const text = '<<DELEGATE to="claude">>write late.txt<</DELEGATE>>';
      options.onLine({ type: "message", text, finalText: text });
      return { exitCode: 0, finalText: text };
    }
    workerStarted();
    await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    // Still writing during the SIGTERM grace period.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(join(options.cwd, "late.txt"), "late\n");
    return { exitCode: 143, finalText: "" };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const session = await orchestra.create({ prompt: "slow", agent: "claude", workers: ["claude"], cwd: repo });
  await started;
  orchestra.stop(session.id);
  assert.equal(session.status, "stopped");
  const info = session.worktrees![0];
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(await readFile(join(info.cwd, "late.txt"), "utf8"), "late\n");
  assert.equal(session.worktrees?.length, 1, "the worktree with the late write is kept");
});

test("a new run waits for an in-flight prune and gets a usable worktree", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const cwds: string[] = [];
  const runner = async (options: RunCliOptions) => {
    let text = "done";
    if (!options.cwd.startsWith(dataDir) && !options.readOnly) text = '<<DELEGATE to="claude">>look only<</DELEGATE>>';
    else if (options.cwd.startsWith(dataDir)) {
      cwds.push(options.cwd);
      // The worktree must exist while the worker runs.
      assert.ok((await stat(options.cwd)).isDirectory());
    }
    options.onLine({ type: "message", text, finalText: text });
    return { exitCode: 0, finalText: text };
  };
  const orchestra = new Orchestra(() => undefined, runner);
  orchestra.worktreeDataDir = dataDir;
  const session = await orchestra.create({ prompt: "first", agent: "claude", workers: ["claude"], cwd: repo });
  await settle(session);
  // The worker changed nothing, so its worktree is being pruned; start the next run right away.
  await orchestra.followup(session.id, "second");
  await settle(session);
  assert.equal(session.status, "done");
  assert.equal(cwds.length, 2);
  const waitStart = Date.now();
  while (session.worktrees && Date.now() - waitStart < 5_000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.worktrees, undefined, "the empty worktree is pruned once the session is idle");
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});

test("a branch with commits survives automatic cleanup even when the worker moved HEAD away", async (t) => {
  const { repo, dataDir } = await tempRepo(t);
  const info = (await ensureWorkerWorktree({ dataDir, sessionId: "abcdef12-9999", workerId: "claude", cwd: repo }))!;
  await writeFile(join(info.path, "work.txt"), "kept\n");
  git(info.path, "add", "-A");
  git(info.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
  git(info.path, "switch", "-q", "--detach", info.base);
  assert.equal((await worktreeStatus(info)).commits, 1);
  await assert.rejects(removeWorktree(info, { onlyIfEmpty: true }));
  assert.equal(git(repo, "rev-list", "--count", `${info.base}..${info.branch}`), "1");
});
