/**
 * Claude Code refuses some compound Bash commands in headless mode no matter what `--allowedTools`
 * says ("This command uses shell operators that require approval", `cd` + redirection), so a worker
 * cannot run `cd src && cat a.txt > b.txt` without a prompt nobody can answer. A PreToolUse hook
 * pre-approves such commands, and its only job is that: it must never approve something a single
 * command could not already do inside the worker folder.
 *
 * What an "allow" decision guarantees (checked statically, before the command runs):
 * - every segment's program is one of a small fixed set (SAFE_PROGRAMS below), with per-program
 *   argument checks: no git global options, `-c`, `config` or writing/exec flags; no
 *   `rg --pre`/follow-symlink flags; npm/pnpm/yarn only `test`/`run` without prefix/global flags;
 * - nothing is expanded: no `$`, backticks, braces, unquoted `~` (at a word start or after `=`/`:`),
 *   unquoted glob characters (`*?[`, which bash 3.2 lets match `..`), comments, here-docs;
 * - no path argument, `cd` target or redirection target has a `..` component, absolute paths must
 *   be inside the worker folder, and every target is resolved with realpath (nearest existing
 *   ancestor), so a symlink inside the folder cannot point the command outside it;
 * - `cd` takes exactly one plain argument (no `-`, `-N`, `+N`, options) and is refused when CDPATH
 *   is set in the hook's environment. Because `cd` may be skipped (`false && cd x`) or run in a
 *   subshell/pipeline, every relative path is checked against every directory the shell could be in.
 *
 * Not guaranteed: what `npm test`/`npm run` scripts or git hooks do (they run project code, exactly
 * as the same single command would under the normal `Bash(npm:*)`/`Bash(git:*)` rules), a CDPATH set
 * only in the user's shell rc (invisible to the hook), and races with other processes changing the
 * folder between the check and the run. Everything not approved gets no decision and falls through
 * to Claude's normal permission rules.
 */
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { shellQuote } from "./worktrees.js";

/** Filesystem and path access the check needs; injected so the function stays self-contained. */
export interface HookHost {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  dirname(path: string): string;
  basename(path: string): string;
  join(...paths: string[]): string;
  sep: string;
  /** Throws when the path cannot be resolved (dangling symlink, permission). */
  realpath(path: string): string;
  /** True when something exists at the path itself (lstat: a dangling symlink exists). */
  exists(path: string): boolean;
  /** CDPATH of the hook's environment; a non-empty value makes `cd` unpredictable, so cd is refused. */
  cdpath?: string;
}

export function nodeHookHost(): HookHost {
  return {
    resolve: nodePath.resolve, relative: nodePath.relative, isAbsolute: nodePath.isAbsolute, dirname: nodePath.dirname, basename: nodePath.basename, join: nodePath.join, sep: nodePath.sep,
    realpath: (path) => realpathSync(path),
    exists: (path) => { try { lstatSync(path); return true; } catch { return false; } },
    cdpath: process.env.CDPATH ?? "",
  };
}

/**
 * Self-contained on purpose: its source is written into the hook script, so it may only use its
 * parameters (no imports, no outer names).
 */
export function bashCommandAllowed(command: string, cwd: string, root: string, host: HookHost): boolean {
  // Path-reading programs: every argument is checked as a path (option values after `=` too).
  const pathPrograms = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "mkdir", "touch", "test"]);
  // Programs that never touch files themselves (only through redirections, checked separately).
  const plainPrograms = new Set(["echo", "printf", "true", "false", "pwd"]);
  const gitSubcommands = new Set(["status", "diff", "log", "show", "add", "commit", "rev-parse", "ls-files", "blame"]);
  const gitDenied = /^(?:-c$|--config|--output|--ext-diff|--textconv|--no-index|--exec|--git-dir|--work-tree|--upload-pack|--receive-pack|--open-files-in-pager|-O)/u;
  const packageManagers = new Set(["npm", "pnpm", "yarn"]);
  const packageDenied = /^(?:--prefix|-C$|--dir|--cwd|-g$|--global|--location|--script-shell|--userconfig|--globalconfig|--workspace-root|-w$|--node-options)/u;
  const resolveReal = (absolute: string): string | undefined => {
    let current = absolute;
    const rest: string[] = [];
    for (let depth = 0; depth < 4096; depth++) {
      if (host.exists(current)) {
        try { return host.join(host.realpath(current), ...rest.reverse()); } catch { return undefined; }
      }
      const parent = host.dirname(current);
      if (parent === current) return undefined;
      rest.push(host.basename(current));
      current = parent;
    }
    return undefined;
  };
  let rootReal: string;
  try { rootReal = host.realpath(host.resolve(root)); } catch { return false; }
  const within = (real: string) => {
    const rel = host.relative(rootReal, real);
    return rel === "" || (rel.split(host.sep)[0] !== ".." && !host.isAbsolute(rel));
  };
  const cwdReal = resolveReal(host.resolve(cwd));
  if (!cwdReal || !within(cwdReal)) return false;
  const hasDotDot = (value: string) => value.split(/[/=:]/u).includes("..");
  /** Real locations `target` can mean from any of `dirs`, or undefined when one leaves the folder. */
  const locate = (target: string, dirs: Set<string>): string[] | undefined => {
    if (!target || hasDotDot(target)) return undefined;
    const candidates = host.isAbsolute(target) ? [host.resolve(target)] : [...dirs].map((dir) => host.resolve(dir, target));
    const found: string[] = [];
    for (const candidate of candidates) {
      const real = resolveReal(candidate);
      if (!real || !within(real)) return undefined;
      found.push(real);
    }
    return found;
  };
  const pathArgsOk = (args: string[], dirs: Set<string>): boolean => {
    let operands = false;
    for (const arg of args) {
      if (hasDotDot(arg)) return false;
      if (!operands && arg === "--") { operands = true; continue; }
      if (!operands && arg.startsWith("-") && arg.length > 1) {
        const eq = arg.indexOf("=");
        if (eq >= 0) { if (!locate(arg.slice(eq + 1) || ".", dirs)) return false; }
        else if (arg.includes("/")) return false; // `-f/etc/x`: an attached path we cannot tell apart
        continue;
      }
      if (!locate(arg, dirs)) return false;
    }
    return true;
  };

  interface Word { text: string; glob: boolean }
  const stack: Set<string>[] = [new Set([cwdReal])];
  const top = () => stack[stack.length - 1];
  let words: Word[] = [];
  const redirects: { kind: "in" | "out"; target: Word }[] = [];
  let text = "";
  let started = false;
  let glob = false;
  let previous = ""; // last unquoted character of the current word ("" at a word start)
  let pendingRedirect: "out" | "in" | undefined;
  let segments = 0;

  const endWord = (): boolean => {
    if (!started) return true;
    const word = { text, glob };
    text = ""; started = false; glob = false; previous = "";
    if (word.glob) return false;
    if (pendingRedirect) {
      redirects.push({ kind: pendingRedirect, target: word });
      pendingRedirect = undefined;
      return true;
    }
    words.push(word);
    return true;
  };
  const segmentOk = (segment: string[], dirs: Set<string>): boolean => {
    const [program, ...args] = segment;
    if (program === "cd") {
      if (args.length !== 1) return false;
      const target = args[0];
      if (!target || target.startsWith("-") || target.startsWith("+")) return false;
      if (host.cdpath) return false;
      const found = locate(target, dirs);
      if (!found) return false;
      // cd may or may not run (`false && cd x`, subshells, pipelines): keep every possibility.
      for (const dir of found) dirs.add(dir);
      return true;
    }
    if (plainPrograms.has(program)) return true;
    if (pathPrograms.has(program)) {
      if (program === "grep" && args.some((arg) => /^-[A-Za-z]*R/u.test(arg) || arg.startsWith("--dereference"))) return false;
      if (program === "rg" && args.some((arg) => /^-[A-Za-z]*L/u.test(arg) || /^--(?:pre|follow)/u.test(arg))) return false;
      if (program === "wc" && args.some((arg) => arg.startsWith("--files0"))) return false;
      return pathArgsOk(args, dirs);
    }
    if (program === "git") {
      if (!gitSubcommands.has(args[0] ?? "")) return false;
      if (args.some((arg) => gitDenied.test(arg))) return false;
      return pathArgsOk(args.slice(1), dirs);
    }
    if (packageManagers.has(program)) {
      if (args[0] !== "test" && args[0] !== "run" && args[0] !== "run-script") return false;
      if (args.some((arg) => packageDenied.test(arg))) return false;
      return pathArgsOk(args.slice(1), dirs);
    }
    return false;
  };
  const endSegment = (): boolean => {
    if (!endWord() || pendingRedirect) return false;
    const segment = words.map((word) => word.text);
    const targets = redirects.splice(0);
    words = [];
    if (!segment.length) return targets.length === 0;
    segments++;
    const dirs = top();
    // Redirections resolve against the directory before this segment's own cd.
    for (const { target } of targets) {
      if (target.text === "/dev/null") continue;
      if (!locate(target.text, dirs)) return false;
    }
    return segmentOk(segment, dirs);
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return false;
      text += command.slice(index + 1, end);
      started = true; previous = "'";
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      let quoted = "";
      while (end < command.length && command[end] !== '"') {
        const inner = command[end];
        if (inner === "$" || inner === "`") return false;
        if (inner === "\\" && end + 1 < command.length) {
          const escaped = command[end + 1];
          if (escaped === "\n") return false;
          if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") { quoted += escaped; end += 2; continue; }
        }
        quoted += inner;
        end++;
      }
      if (end >= command.length) return false;
      text += quoted;
      started = true; previous = '"';
      index = end;
    } else if (char === "\\") {
      if (next === undefined || next === "\n") return false;
      text += next;
      started = true; previous = "\\";
      index++;
    } else if (char === "$" || char === "`" || char === "\n" || char === "\r" || char === "{" || char === "}") {
      return false;
    } else if (char === "~" && (!started || previous === "=" || previous === ":")) {
      return false;
    } else if (char === "#" && !started) {
      return false;
    } else if (char === " " || char === "\t") {
      if (!endWord()) return false;
    } else if (char === "&" || char === "|" || char === ";") {
      if (char === "&" && next === ">") return false;
      if (char === "|" && next === "&") return false;
      if (char === ";" && next === ";") return false;
      if ((char === "&" || char === "|") && next === char) index++;
      if (!endSegment()) return false;
    } else if (char === "(") {
      if (started || words.length || redirects.length) return false;
      if (!endSegment()) return false;
      stack.push(new Set(top()));
    } else if (char === ")") {
      if (!endSegment() || stack.length < 2) return false;
      stack.pop();
    } else if (char === ">" || char === "<") {
      // `2>` / `1>`: a digits-only word right before the operator is the fd, not an argument.
      if (started && /^\d+$/u.test(text) && previous !== "'" && previous !== '"' && previous !== "\\") { text = ""; started = false; previous = ""; }
      else if (!endWord()) return false;
      if (pendingRedirect) return false;
      if (char === "<" && (next === "<" || next === ">" || next === "(")) return false;
      if (char === ">" && next === "(") return false;
      if (char === ">" && (next === ">" || next === "|")) index++;
      if (command[index + 1] === "&") {
        // `2>&1`: fd duplication, no file.
        index++;
        let fd = "";
        while (/\d/u.test(command[index + 1] ?? "")) fd += command[++index];
        if (!fd) return false;
        continue;
      }
      pendingRedirect = char === ">" ? "out" : "in";
    } else {
      if (char === "*" || char === "?" || char === "[") glob = true;
      text += char;
      started = true; previous = char;
    }
  }
  if (!endSegment() || stack.length !== 1) return false;
  return segments > 0;
}

/** The PreToolUse hook as a standalone Node script (reads the hook JSON on stdin). */
export function bashHookScript(): string {
  return `// Generated by Sinawi: pre-approves compound Bash commands of safe programs confined to the worker folder.
import * as path from "node:path";
import * as fs from "node:fs";
const host = {
  resolve: path.resolve, relative: path.relative, isAbsolute: path.isAbsolute, dirname: path.dirname, basename: path.basename, join: path.join, sep: path.sep,
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => { try { fs.lstatSync(p); return true; } catch { return false; } },
  cdpath: process.env.CDPATH || "",
};
const root = process.argv[2];
// Transpilers with keepNames (tsx/esbuild) wrap inner functions in __name(); make it a no-op here.
const __name = (fn) => fn;
const bashCommandAllowed = ${bashCommandAllowed.toString()};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const command = data && data.tool_input && typeof data.tool_input.command === "string" ? data.tool_input.command : "";
    const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : root;
    if (root && command && bashCommandAllowed(command, cwd, root, host)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Sinawi: safe programs confined to the worker folder" } }));
    }
  } catch {}
});
`;
}

/** Writes (or refreshes) the hook script under `dataDir` and returns its path. */
export async function ensureBashHookScript(dataDir: string): Promise<string> {
  const directory = nodePath.join(dataDir, "hooks");
  const file = nodePath.join(directory, "claude-bash-guard.mjs");
  const script = bashHookScript();
  const current = await readFile(file, "utf8").catch(() => "");
  if (current !== script) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, script, { mode: 0o600 });
  }
  return file;
}

/** `--settings` JSON that runs the hook for Bash calls, bounded to `root`. */
export function bashHookSettings(scriptPath: string, root: string, nodeBinary = process.execPath): string {
  const command = [nodeBinary, scriptPath, root].map(shellQuote).join(" ");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }] } });
}
