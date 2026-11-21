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
 *   `rg --pre`/follow-symlink flags; npm/pnpm/yarn only `test`/`run` without prefix/global flags, and
 *   only where the workspace pre-approves programs that run code (H2, `runtime` argument);
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
  /** The workspace pre-approves programs that run code (npm/pnpm/yarn scripts): WorkspacePolicy.runtimePrograms. */
  runtimePrograms?: boolean;
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
 * Whether a Bash command starts one of the programs that run code they are given (supervision.ts
 * RUNTIME_SHELL_PROGRAMS, plus their close kin). With the workspace switch off, the hook answers "ask"
 * for these, so Claude's own auto mode (which decides unlisted commands by itself) still brings them
 * to the user (third review N3). Best effort and on the cautious side: every segment between shell
 * operators, quotes and substitutions is looked at, after env assignments and wrapper commands
 * (env, command, exec, nohup, time, xargs, nice, timeout ...), so `bash -c "node -v"`, `FOO=1 npx x`,
 * `/usr/local/bin/node` and `cd a && node b` count; text that merely starts with such a word inside
 * quotes (`echo "node is"`) asks too. A program it does not know (a shell script, ruby, perl) is not
 * caught: that stays with Claude's own judgement, as the settings text says.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function runsCodeCommand(command: string): boolean {
  const runtime = new Set(["node", "nodejs", "npx", "python", "python3", "npm", "pnpm", "pnpx", "yarn", "bun", "bunx", "deno", "tsx", "ts-node", "find"]);
  const wrappers = new Set(["env", "command", "exec", "nohup", "time", "xargs", "nice", "timeout", "builtin", "caffeinate", "stdbuf", "sudo", "doas"]);
  const segments = command.split(/[;&|\n()`'"{}]|\$\(/u);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/u).filter(Boolean);
    let index = 0;
    for (;;) {
      const word = words[index];
      if (word === undefined) break;
      // FOO=1 node ..., env -i node ..., timeout 5 node ..., xargs -n1 node ...
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) || word.startsWith("-") || /^\d+[smhd]?$/u.test(word)) { index += 1; continue; }
      const name = word.slice(word.lastIndexOf("/") + 1).replace(/\\/gu, "");
      if (wrappers.has(name)) { index += 1; continue; }
      if (runtime.has(name) || /^python3(?:\.\d+)?$/u.test(name)) return true;
      if (name === "ao-serve" && words[index + 1] === "start") return true;
      break;
    }
  }
  return false;
}

/**
 * Forms of pre-approved programs that reach outside the project (third review H2-b): `gh api` with a
 * method or fields (writes to GitHub), `git push` that forces, deletes or mirrors, `xcrun simctl
 * spawn` (runs a program on the host), `trash` of a path outside the folder. The prefix rules
 * pre-approve the plain program; for these forms the hook answers "ask", so the user decides.
 * Grok denies the same forms by pattern (supervision.ts RISKY_SHELL_PATTERNS).
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function riskyCommand(command: string): boolean {
  for (const segment of command.split(/[;&|\n()`]|\$\(/u)) {
    const words = segment.trim().split(/\s+/u).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/gu, ""));
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]!) || ["env", "command", "exec", "nohup", "time"].includes(words[index]!))) index += 1;
    const program = (words[index] ?? "").replace(/^.*\//u, "");
    const rest = words.slice(index + 1);
    if (program === "gh" && rest[0] === "api") {
      for (let at = 1; at < rest.length; at++) {
        const word = rest[at]!;
        if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/u.test(word) || /^-[fF]./u.test(word)) return true;
        const method = /^(?:-X|--method)(?:=(.*))?$/u.exec(word) ?? /^-X(.+)$/u.exec(word);
        if (method) { const value = (method[1] ?? rest[at + 1] ?? "").toUpperCase(); if (value !== "GET") return true; }
      }
    }
    if (program === "git") {
      const push = rest.indexOf("push");
      if (push >= 0 && rest.slice(push + 1).some((word) => /^(?:-f|-d|--force.*|--delete|--mirror|--prune|--all)$/u.test(word) || /^-[a-z]*[fd][a-z]*$/u.test(word) || /^[+:]/u.test(word))) return true;
    }
    if (program === "xcrun" && rest[0] === "simctl" && rest[1] === "spawn") return true;
    if (program === "trash" && rest.some((word) => word.startsWith("/") || word.startsWith("~") || word.split("/").includes(".."))) return true;
  }
  return false;
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
      if (!host.runtimePrograms) return false;
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
  runtimePrograms: process.argv[3] === "runtime",
};
const root = process.argv[2];
// Transpilers with keepNames (tsx/esbuild) wrap inner functions in __name(); make it a no-op here.
const __name = (fn) => fn;
const bashCommandAllowed = ${bashCommandAllowed.toString()};
const runsCodeCommand = ${runsCodeCommand.toString()};
const riskyCommand = ${riskyCommand.toString()};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const command = data && data.tool_input && typeof data.tool_input.command === "string" ? data.tool_input.command : "";
    const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : root;
    // The workspace has not pre-approved programs that run code: such a command goes to the user,
    // even where Claude's auto mode would decide it by itself.
    if (command && !host.runtimePrograms && runsCodeCommand(command)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Sinawi: this workspace does not pre-approve commands that run code (node, npx, python3, npm, find, ...)" } }));
      return;
    }
    if (command && riskyCommand(command)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Sinawi: this command reaches outside the project (gh api write, forced or deleting git push, simctl spawn, trash outside the folder)" } }));
      return;
    }
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
export function bashHookSettings(scriptPath: string, root: string, nodeBinary = process.execPath, runtimePrograms = false): string {
  const command = [nodeBinary, scriptPath, root, ...(runtimePrograms ? ["runtime"] : [])].map(shellQuote).join(" ");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }] } });
}
