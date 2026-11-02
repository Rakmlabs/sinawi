/**
 * Per-worker git worktrees. When a session folder is inside a git repository, every worker that may
 * write files runs in its own worktree on its own branch, so parallel or successive workers never
 * edit the same checkout. The app never merges: the developer reviews and merges the branches.
 *
 * Worktrees live under `<data dir>/worktrees/<repo>-<hash>/`, outside the repository, so they need
 * no .gitignore entry and repo-wide tools (rg, tsc, test runners) never pick up the copies.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import type { WorktreeInfo, WorktreeStatus } from "./types.js";

export type { WorktreeInfo, WorktreeStatus };

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try { return await git(cwd, args); } catch { return undefined; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Repository root and HEAD commit of `cwd`, or undefined outside git (or in a repo with no commits yet). */
export async function gitRepo(cwd: string): Promise<{ root: string; head: string } | undefined> {
  const root = (await tryGit(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return;
  const head = (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.trim();
  if (!head) return;
  return { root, head };
}

export function worktreeBranch(sessionId: string, workerId: string): string {
  return `sinawi/${sessionId.slice(0, 8)}/${workerId.replace(/[^A-Za-z0-9_-]+/gu, "-") || "worker"}`;
}

export function worktreesDir(dataDir: string, repoRoot: string): string {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  return join(dataDir, "worktrees", `${basename(repoRoot).replace(/[^\w.-]+/gu, "_")}-${hash}`);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  return (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== undefined;
}

async function registeredWorktrees(repoRoot: string): Promise<Set<string>> {
  const list = (await tryGit(repoRoot, ["worktree", "list", "--porcelain"])) ?? "";
  const paths = list.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  const resolved = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  return new Set(resolved);
}

/** The repository's own worktrees (the user's checkouts), leaving out the ones Sinawi made under `dataDir`. */
export async function userWorktrees(cwd: string, dataDir: string): Promise<{ path: string; branch?: string; head: string }[]> {
  const list = (await tryGit(cwd, ["worktree", "list", "--porcelain"])) ?? "";
  const ours = join(dataDir, "worktrees") + "/";
  return list.split("\n\n").flatMap((block) => {
    const fields = new Map(block.split("\n").map((line) => [line.split(" ", 1)[0], line.slice(line.indexOf(" ") + 1)] as const));
    const path = fields.get("worktree");
    if (!path || (path + "/").startsWith(ours) || fields.has("bare")) return [];
    return [{ path, branch: fields.get("branch")?.replace(/^refs\/heads\//u, ""), head: (fields.get("HEAD") ?? "").slice(0, 7) }];
  });
}

async function hasUncommitted(path: string): Promise<boolean> {
  return Boolean((await tryGit(path, ["status", "--porcelain", "--untracked-files=normal"]))?.trim());
}

/**
 * The worker's worktree for this session: reused when it still exists, recreated from its branch
 * when only the branch is left, otherwise made fresh from HEAD. Undefined when `cwd` is not in git.
 */
export async function ensureWorkerWorktree(input: { dataDir: string; sessionId: string; workerId: string; workerLabel?: string; cwd: string; existing?: WorktreeInfo }): Promise<WorktreeInfo | undefined> {
  const repo = await gitRepo(input.cwd);
  if (!repo) return;
  const repoRoot = await realpath(repo.root);
  const subdir = relative(repoRoot, await realpath(input.cwd));
  const mainDirty = await hasUncommitted(repoRoot);
  const existing = input.existing;
  if (existing && existing.repoRoot === repoRoot && await isDirectory(existing.path) && (await registeredWorktrees(repoRoot)).has(await realpath(existing.path))) {
    return { ...existing, workerLabel: input.workerLabel ?? existing.workerLabel, mainDirty };
  }
  const branch = existing?.branch ?? worktreeBranch(input.sessionId, input.workerId);
  const root = worktreesDir(input.dataDir, repoRoot);
  await mkdir(root, { recursive: true });
  await tryGit(repoRoot, ["worktree", "prune"]);
  const name = `${input.sessionId.slice(0, 8)}-${input.workerId.replace(/[^A-Za-z0-9_-]+/gu, "-")}`;
  let path = join(root, name);
  for (let suffix = 2; await isDirectory(path); suffix++) path = join(root, `${name}-${suffix}`);
  let base = repo.head;
  if (await branchExists(repoRoot, branch)) {
    await git(repoRoot, ["worktree", "add", path, branch]);
    base = existing?.base ?? (await git(repoRoot, ["merge-base", repo.head, branch])).trim();
  } else {
    await git(repoRoot, ["worktree", "add", "-b", branch, path, repo.head]);
  }
  const cwd = subdir && !subdir.startsWith("..") ? join(path, subdir) : path;
  await mkdir(cwd, { recursive: true });
  return { workerId: input.workerId, workerLabel: input.workerLabel, branch, path, cwd, repoRoot, base, createdAt: existing?.createdAt ?? new Date().toISOString(), mainDirty };
}

/** `git status --porcelain -z` entries: path (the new path for renames) and whether it is untracked. */
function porcelainEntries(output: string): { path: string; untracked: boolean }[] {
  const entries: { path: string; untracked: boolean }[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ path: field.slice(3), untracked: code === "??" });
    // Renames and copies carry the original path as the next NUL-separated field.
    if (code[0] === "R" || code[0] === "C") index++;
  }
  return entries;
}

const NOISE_COMPARE_LIMIT = 16 * 1024 * 1024;

/** True when `main` is a regular file with exactly the bytes of `copy` (neither is a symlink). */
async function sameFile(copy: string, main: string): Promise<boolean> {
  const [a, b] = await Promise.all([lstat(copy).catch(() => undefined), lstat(main).catch(() => undefined)]);
  if (!a?.isFile() || !b?.isFile() || a.size !== b.size || a.size > NOISE_COMPARE_LIMIT) return false;
  const [left, right] = await Promise.all([readFile(copy), readFile(main)]);
  return left.equals(right);
}

/**
 * Untracked worktree files that are byte-identical copies of a file at the same path in the main
 * tree. Tools that write into every working folder (editor or agent state such as `.omc/`) leave
 * the same files in each worktree; those are not the worker's work, and committing them would make
 * the merge fail on the main tree's own copies. Compared per file: a new file the worker made next
 * to them (even under the same untracked folder) is work, not noise.
 */
async function mainCopies(info: Pick<WorktreeInfo, "path" | "repoRoot">, entries: { path: string; untracked: boolean }[]): Promise<Set<string>> {
  const noise = new Set<string>();
  for (const entry of entries) {
    if (entry.untracked && await sameFile(join(info.path, entry.path), join(info.repoRoot, entry.path))) noise.add(entry.path);
  }
  return noise;
}

export function mergeCommand(info: Pick<WorktreeInfo, "repoRoot" | "path" | "branch" | "workerLabel" | "workerId">, uncommitted: number, exclude: string[] = []): string {
  const merge = `git -C ${shellQuote(info.repoRoot)} merge --no-ff ${shellQuote(info.branch)}`;
  if (!uncommitted) return merge;
  const message = `sinawi: ${info.workerLabel ?? info.workerId} 작업`;
  const pathspec = exclude.length ? ` -- . ${exclude.map((entry) => shellQuote(`:(exclude)${entry}`)).join(" ")}` : "";
  return `git -C ${shellQuote(info.path)} add -A${pathspec} && git -C ${shellQuote(info.path)} commit -m ${shellQuote(message)} && ${merge}`;
}

/**
 * What the worktree holds. Throws when git cannot answer (status, diff or rev-list fails): callers
 * that delete must treat "could not check" as "keep", never as "nothing there".
 */
export async function worktreeStatus(info: WorktreeInfo): Promise<WorktreeStatus> {
  return (await inspectWorktree(info)).status;
}

async function inspectWorktree(info: WorktreeInfo): Promise<{ status: WorktreeStatus; noise: string[]; untracked: string[] }> {
  const exists = await isDirectory(info.path) && (await git(info.path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  if (!exists) {
    const commits = await branchExists(info.repoRoot, info.branch)
      ? Number((await git(info.repoRoot, ["rev-list", "--count", `${info.base}..${info.branch}`])).trim())
      : 0;
    if (!Number.isFinite(commits)) throw new Error(`커밋 수를 확인하지 못했습니다: ${info.branch}`);
    return { status: { ...info, exists, changedFiles: 0, files: [], uncommitted: 0, commits, mergeCommand: mergeCommand(info, 0) }, noise: [], untracked: [] };
  }
  const entries = porcelainEntries(await git(info.path, ["status", "--porcelain", "-z", "--untracked-files=all"]));
  const noise = await mainCopies(info, entries);
  const uncommittedFiles = entries.map((entry) => entry.path).filter((file) => !noise.has(file));
  const committedFiles = (await git(info.path, ["diff", "--name-only", info.base, "HEAD"])).split("\n").filter(Boolean);
  const files = [...new Set([...committedFiles, ...uncommittedFiles])].sort();
  // Count both HEAD and the branch: a worker may have switched HEAD away (detach, another branch),
  // and the branch is what removal deletes, so its commits must count even when HEAD is elsewhere.
  const headCommits = Number((await git(info.path, ["rev-list", "--count", `${info.base}..HEAD`])).trim());
  const branchCommits = await branchExists(info.repoRoot, info.branch)
    ? Number((await git(info.repoRoot, ["rev-list", "--count", `${info.base}..${info.branch}`])).trim())
    : 0;
  const commits = Math.max(headCommits, branchCommits);
  if (!Number.isFinite(commits)) throw new Error(`커밋 수를 확인하지 못했습니다: ${info.branch}`);
  const noiseList = [...noise].sort();
  return { status: { ...info, exists, changedFiles: files.length, files: files.slice(0, 50), uncommitted: uncommittedFiles.length, commits, mergeCommand: mergeCommand(info, uncommittedFiles.length, noiseList) }, noise: noiseList, untracked: entries.filter((entry) => entry.untracked && !noise.has(entry.path)).map((entry) => entry.path) };
}

export class WorktreeDirtyError extends Error {
  readonly code = "WORKTREE_DIRTY";
  constructor(readonly uncommitted: number) {
    super(`커밋되지 않은 변경 ${uncommitted}개가 있어 worktree를 지우지 않았습니다. 지우면 그 변경은 사라집니다.`);
  }
}

export class WorktreeNotEmptyError extends Error {
  readonly code = "WORKTREE_NOT_EMPTY";
  constructor() { super("worktree에 변경이나 커밋이 있어 자동 정리하지 않았습니다."); }
}

/**
 * Removes the worktree folder. Refuses with uncommitted changes unless `force`. The branch is
 * deleted only when it has no commits after `base` (nothing to lose); otherwise it is kept.
 *
 * `onlyIfEmpty` is the automatic path: it refuses unless the worktree holds no change and no
 * commit, and it never passes `--force` to git, so anything git itself considers worth keeping
 * (untracked or modified files, even identical copies of main-tree files) makes it throw and the
 * folder stays.
 */
export async function removeWorktree(info: WorktreeInfo, options: { force?: boolean; onlyIfEmpty?: boolean } = {}): Promise<{ branchKept: boolean; commits: number }> {
  const status = await worktreeStatus(info);
  if (options.onlyIfEmpty) {
    if (status.changedFiles > 0 || status.commits > 0) throw new WorktreeNotEmptyError();
    if (status.exists) await git(info.repoRoot, ["worktree", "remove", info.path]);
    else await tryGit(info.repoRoot, ["worktree", "prune"]);
    // Zero commits after base on both HEAD and the branch, so the branch holds nothing.
    if (await branchExists(info.repoRoot, info.branch)) await git(info.repoRoot, ["branch", "-D", info.branch]);
    return { branchKept: false, commits: 0 };
  }
  if (status.exists && status.uncommitted > 0 && !options.force) throw new WorktreeDirtyError(status.uncommitted);
  // --force past this point: what is left is either confirmed by the user or only byte-identical
  // copies of main-tree files (see mainCopies).
  if (status.exists) await git(info.repoRoot, ["worktree", "remove", "--force", info.path]);
  else await tryGit(info.repoRoot, ["worktree", "prune"]);
  if (!await branchExists(info.repoRoot, info.branch)) return { branchKept: false, commits: status.commits };
  if (status.commits > 0) return { branchKept: true, commits: status.commits };
  await git(info.repoRoot, ["branch", "-D", info.branch]);
  return { branchKept: false, commits: 0 };
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What the lead needs to review worker changes: where they are and what changed. */
export async function worktreeReviewNote(infos: WorktreeInfo[]): Promise<string> {
  if (!infos.length) return "";
  const sections = await Promise.all(infos.map(async (info) => {
    const inspected = await inspectWorktree(info).catch(() => undefined);
    if (!inspected) return `- ${info.workerLabel ?? info.workerId}: 경로 \`${info.path}\`, 브랜치 \`${info.branch}\`. git 상태를 확인하지 못했습니다. 이 경로를 직접 확인하세요.`;
    const { status, untracked } = inspected;
    const stat = status.exists ? ((await tryGit(info.path, ["diff", "--stat", info.base])) ?? "").trim() : "";
    const lines = [
      `- ${info.workerLabel ?? info.workerId}: 경로 \`${info.path}\`, 브랜치 \`${info.branch}\` (기준 ${info.base.slice(0, 10)})`,
      `  바뀐 파일 ${status.changedFiles}개, 커밋 ${status.commits}개, 커밋되지 않은 파일 ${status.uncommitted}개.`,
      ...(status.files.length ? [`  파일: ${status.files.slice(0, 20).map((file) => `\`${file}\``).join(", ")}${status.files.length > 20 ? " …" : ""}`] : []),
      ...(stat ? [`  diff --stat:\n${clip(stat, 1_500).split("\n").map((line) => `    ${line}`).join("\n")}`] : []),
      ...(untracked.length ? [`  새 파일(추적 안 됨): ${untracked.slice(0, 20).join(", ")}`] : []),
      ...(info.mainDirty ? ["  주의: 메인 폴더에 커밋되지 않은 변경이 있었고, 그 변경은 이 worktree에 없습니다(HEAD 기준)."] : []),
    ];
    return lines.join("\n");
  }));
  return `## 워커 변경 위치 (git worktree)
파일을 고친 워커는 메인 작업 폴더가 아니라 각자 아래 worktree에서 일했습니다. 검토할 때는 이 경로의 파일을 읽으세요(메인 폴더에는 이 변경이 없습니다). 앱은 자동 병합하지 않습니다. 최종 답에 각 워커의 브랜치 이름을 적고, 병합은 개발자가 직접 한다고 알리세요.
${sections.join("\n")}`;
}

/** Note for the worker itself: where it runs and what is (not) there. */
export function worktreeWorkerNote(info: WorktreeInfo, mainCwd: string): string {
  return `## 작업 위치 (git worktree)
이 작업은 전용 git worktree \`${info.cwd}\` (브랜치 \`${info.branch}\`)에서 실행된다. 현재 작업 디렉터리가 이미 그곳이다. 파일은 이 폴더 안에서만 고치고, 메인 폴더 \`${mainCwd}\`는 수정하지 않는다. 커밋·브랜치 전환·병합은 브리프에 있을 때만 한다.
- 이 worktree는 마지막 커밋(HEAD) 기준이다.${info.mainDirty ? " 메인 폴더의 커밋되지 않은 변경은 여기에 없다." : ""} node_modules처럼 git에 없는 파일(의존성, 빌드 결과, .env)도 없다. 검증에 필요하면 메인 폴더의 것을 절대 경로로 쓰고(예: \`node ${mainCwd}/node_modules/.bin/tsc\`), 그래도 안 되면 그 사실을 보고한다.`;
}

/** Uncommitted changes in the session's main checkout (they are not copied into worktrees). */
export async function mainTreeDirty(cwd: string): Promise<boolean> {
  const repo = await gitRepo(cwd);
  return repo ? hasUncommitted(repo.root) : false;
}

/**
 * Removes worktrees that hold nothing: no file differs from `base` and no commits. Returns the
 * entries still worth keeping (changes or commits, ones that could not be checked, ones git would
 * not remove without --force, or ones `canRemove` vetoed). `canRemove` is asked right before each
 * deletion, so a caller can stop pruning once a new run has started.
 */
export async function pruneEmptyWorktrees(infos: WorktreeInfo[], options: { canRemove?: (info: WorktreeInfo) => boolean } = {}): Promise<WorktreeInfo[]> {
  const kept: WorktreeInfo[] = [];
  for (const info of infos) {
    try {
      const status = await worktreeStatus(info);
      if (status.changedFiles === 0 && status.commits === 0 && (options.canRemove?.(info) ?? true)) {
        // Re-checks the status itself and never forces: a file written since the check keeps it.
        await removeWorktree(info, { onlyIfEmpty: true });
        continue;
      }
    } catch { /* keep it: never lose a worktree because a check or a plain remove failed */ }
    kept.push(info);
  }
  return kept;
}

/**
 * Session deletion with cleanup: removes every worktree without uncommitted changes. Branches with
 * commits are kept (removeWorktree never deletes them); dirty worktrees are kept whole.
 */
export async function cleanupSessionWorktrees(infos: WorktreeInfo[]): Promise<{ removed: string[]; kept: { branch: string; path: string; reason: "uncommitted" | "commits" | "failed" }[] }> {
  const removed: string[] = [];
  const kept: { branch: string; path: string; reason: "uncommitted" | "commits" | "failed" }[] = [];
  for (const info of infos) {
    try {
      const result = await removeWorktree(info);
      removed.push(info.path);
      if (result.branchKept) kept.push({ branch: info.branch, path: info.path, reason: "commits" });
    } catch (error) {
      kept.push({ branch: info.branch, path: info.path, reason: error instanceof WorktreeDirtyError ? "uncommitted" : "failed" });
    }
  }
  return { removed, kept };
}
