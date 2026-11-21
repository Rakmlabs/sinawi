/**
 * Claude Code refuses some compound Bash commands in headless mode no matter what `--allowedTools`
 * says ("This command uses shell operators that require approval", `cd` + redirection), so a worker
 * cannot run `cd src && cat a.txt > b.txt` without a prompt nobody can answer. A PreToolUse hook
 * pre-approves such commands; it must never approve something a single command could not already do
 * inside the worker folder. The same hook also asks (hookDecision): for risky forms always, and while
 * the workspace does not pre-approve programs that run code, for every command that is not a simple
 * pre-approved one — Claude's own auto mode would otherwise decide those by itself.
 *
 * What an "allow" decision guarantees (checked statically, before the command runs):
 * - every segment's program is one of a small fixed set (bashCommandAllowed), and uses only the
 *   subcommands and options listed for it (optionsAllowed: no git global options, `-c`, `config` or
 *   writing/exec flags; no `rg --pre`/follow-symlink flags); `find` only with listing primaries;
 *   npm/pnpm/yarn only `test`/`run` without prefix/global flags, and only where the workspace
 *   pre-approves programs that run code (H2, `runtime` argument);
 * - in a chain, no step writes files before another step runs, and none writes when steps run at the
 *   same time (`|`, `&`): the chain is judged once, before it runs (eighth review R8-1);
 * - nothing is expanded: no `$`, backticks, braces, unquoted `~` (at a word start or after `=`/`:`),
 *   unquoted glob characters (`*?[`, which bash 3.2 lets match `..`), comments, here-docs;
 * - no path argument, `cd` target or redirection target has a `..` component, absolute paths must
 *   be inside the worker folder, and every target is resolved with realpath (nearest existing
 *   ancestor), so a symlink inside the folder cannot point the command outside it;
 * - `cd` takes exactly one plain argument (no `-`, `-N`, `+N`, options) and is refused when CDPATH
 *   is set in the hook's environment. Because `cd` may be skipped (`false && cd x`) or run in a
 *   subshell/pipeline, every relative path is checked against every directory the shell could be in.
 *
 * Not guaranteed: what `npm test`/`npm run` scripts or git hooks and config already in the repository
 * do (they run project code, exactly as the same single command would under the normal
 * `Bash(npm:*)`/`Bash(git:*)` rules; while the switch is off, writing into a `.git` folder asks,
 * inGitDir), a CDPATH set
 * only in the user's shell rc (invisible to the hook), and races with other processes changing the
 * folder between the check and the run. What is neither approved nor asked for here gets no decision
 * and falls through to Claude's normal permission rules.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { DEVELOPMENT_SHELL_PROGRAMS } from "./supervision.js";
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
  /** Runs `git ARGS` in `cwd` (no pager, no prompts) and returns stdout, or undefined when it fails. */
  git?(cwd: string, args: string[]): string | undefined;
}

export function nodeHookHost(): HookHost {
  return {
    resolve: nodePath.resolve, relative: nodePath.relative, isAbsolute: nodePath.isAbsolute, dirname: nodePath.dirname, basename: nodePath.basename, join: nodePath.join, sep: nodePath.sep,
    realpath: (path) => realpathSync(path),
    exists: (path) => { try { lstatSync(path); return true; } catch { return false; } },
    cdpath: process.env.CDPATH ?? "",
    git: (cwd, args) => {
      const result = spawnSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", timeout: 4000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
      return result.status === 0 ? result.stdout.replace(/\n$/u, "") : undefined;
    },
  };
}

/**
 * The words of `command` when it is ONE simple command whose words are fixed text the hook reads
 * exactly as the shell will, else undefined. Fourth review R4-2: matching dangerous shapes one by one
 * lost to the shell (`"no""de"`, `n''ode`, `$(which node)`), so the hook works the other way round:
 * only this narrow form can pass without a card while the workspace switch is off.
 *
 * A word is plain characters (letters, digits, `_-.,/:@%+=^`), one whole quoted string, or
 * `--name="value"`. Anything else makes the command not fixed: a quote glued to other text, `$`
 * (variables, `$(…)`), backticks, `\`, globs (`*?[`), `~`, `!`, `#`, braces, parentheses, `;&|<>`
 * (chains, pipes, redirections), newlines.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function staticCommandWords(command: string): string[] | undefined {
  const plain = /^[\p{L}\p{N}_\-.,/:@%+=^]$/u;
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === " " || char === "\t") { index += 1; continue; }
    let word = "";
    // `~` mid-word (`HEAD~3`) is plain text; at a word start or after `=`/`:` the shell expands it.
    while (index < command.length && (plain.test(command[index]!) || (command[index] === "~" && word !== "" && !/[=:]$/u.test(word)))) word += command[index++];
    const quote = command[index];
    if (quote === "'" || quote === '"') {
      // `"no""de"`, `n''ode`, `"no"de`: a quote glued to other text. Only `--name="value"` may glue.
      if (word !== "" && !word.endsWith("=")) return undefined;
      const end = command.indexOf(quote, index + 1);
      if (end < 0) return undefined;
      const inner = command.slice(index + 1, end);
      if (/[\n\r]/u.test(inner) || (quote === '"' && /[$`\\!]/u.test(inner))) return undefined;
      word += inner;
      index = end + 1;
    }
    const after = command[index];
    if (after !== undefined && after !== " " && after !== "\t") return undefined;
    words.push(word);
  }
  return words.length ? words : undefined;
}

/**
 * Forms of pre-approved programs that reach outside the project (third review H2-b), on the words of
 * one command: `gh api` with a method or fields (writes to GitHub), `git push` that forces, deletes
 * or mirrors, `xcrun simctl spawn` (runs a program on the host), `curl -K` (a config file can set any
 * option), `trash` of a path outside the folder. The prefix rules pre-approve the plain program; for
 * these forms the hook answers "ask", whatever the workspace switch says. Grok denies the same forms
 * by pattern (supervision.ts RISKY_SHELL_PATTERNS).
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function riskyWords(words: string[]): boolean {
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
  if (program === "git") {
    // Global options before the subcommand that run a program or set config (`-c core.pager=…`,
    // `--exec-path=.`), and the options that name the program run on the other side of a transfer.
    for (let at = 0; at < rest.length && rest[at]!.startsWith("-"); at++) {
      if (/^(?:-c|--config-env|--exec-path)/u.test(rest[at]!)) return true;
      if (rest[at] === "-C") at++;
    }
    if (rest.some((word) => /^--(?:upl|rece|exec)/u.test(word))) return true;
  }
  if (program === "rg" && rest.some((word) => word.startsWith("--pre"))) return true;
  // `--co` is the shortest abbreviation GNU sort accepts for --compress-program.
  if (program === "sort" && rest.some((word) => word.startsWith("--co"))) return true;
  if (program === "curl" && rest.some((word) => /^(?:-K|--config)/u.test(word) || /^-[a-zA-Z]*K/u.test(word))) return true;
  if (program === "xcrun" && rest[0] === "simctl" && rest[1] === "spawn") return true;
  if (program === "trash" && rest.some((word) => word.startsWith("/") || word.startsWith("~") || word.split("/").includes(".."))) return true;
  return false;
}

/**
 * `riskyWords` over every segment of a command the hook cannot read as fixed words (used while the
 * workspace switch is on, when such commands are otherwise left to Claude's own judgement).
 *
 * Uses only the other hook functions (its source goes into the hook script).
 */
export function riskyCommand(command: string): boolean {
  return command.split(/[;&|\n()`]|\$\(/u).some((segment) => riskyWords(segment.trim().split(/\s+/u).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/gu, ""))));
}

/**
 * How many leading words of `words` are one of the pre-approved prefixes (`git status`, `ls`,
 * `xcrun simctl list` …), or 0.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function preapprovedPrefix(words: string[], prefixes: readonly string[]): number {
  let best = 0;
  for (const prefix of prefixes) {
    const parts = prefix.split(" ");
    if (parts.length > best && parts.every((part, index) => words[index] === part)) best = parts.length;
  }
  return best;
}

/**
 * Whether every argument that names a file stays inside the worker folder: no `~`, no `..`, no
 * `file:` URL, and absolute or relative paths (also `--opt=PATH`, `-oPATH`, `@PATH`) resolve, through
 * symlinks, inside `root`. Words that are not paths (a URL, a commit message) resolve inside too.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function argumentsStayInside(args: string[], cwd: string, root: string, host: HookHost): boolean {
  let rootReal: string;
  try { rootReal = host.realpath(host.resolve(root)); } catch { return false; }
  const within = (real: string) => {
    const rel = host.relative(rootReal, real);
    return rel === "" || (rel.split(host.sep)[0] !== ".." && !host.isAbsolute(rel));
  };
  const inside = (value: string): boolean => {
    if (!value) return true;
    if (value.startsWith("~") || /^file:/iu.test(value) || value.split(/[/=:]/u).includes("..")) return false;
    let current = host.isAbsolute(value) ? host.resolve(value) : host.resolve(cwd, value);
    const rest: string[] = [];
    for (let depth = 0; depth < 4096; depth++) {
      if (host.exists(current)) {
        try { return within(host.join(host.realpath(current), ...rest.reverse())); } catch { return false; }
      }
      const parent = host.dirname(current);
      if (parent === current) return false;
      rest.push(host.basename(current));
      current = parent;
    }
    return false;
  };
  for (const arg of args) {
    const values = [arg];
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq > 0) values.push(arg.slice(eq + 1));
      else if (arg.includes("/")) values.push(arg.slice(arg.indexOf("/")));
    }
    for (const value of [...values]) if (value.startsWith("@")) values.push(value.slice(1));
    if (!values.every(inside)) return false;
  }
  return true;
}

/**
 * Whether the words of one command use only the subcommands and options listed for its program
 * (fifth review R5-1: `sort --compress-program=./x`, `git fetch --upload-pack=./x`, `rg --pre=./x`
 * ran code under the plain prefix rules). An allowlist, not a list of dangerous flags: a program,
 * subcommand, option or `VAR=value` prefix that is not listed returns false and the hook asks.
 *
 * - The spec is chosen by the longest key that the leading words match (`git log`, `gh pr`, `ls`).
 *   No key (git global options such as `-c`/`-C`/`--exec-path`, `env`, `xargs`, `GIT_X=1 git …`)
 *   is false.
 * - Long options must be written out in full (`--name` or `--name=value`). An abbreviation that GNU
 *   getopt or git would accept (`--compress-prog`) is not on the list, so it asks.
 * - Every letter of a short cluster is checked (`rg -nz`). A letter listed as taking a value
 *   (`-m`, `-A3`) ends the cluster: the rest is its value. A value in the next word is never skipped:
 *   it is checked like any other word, so a mis-listed option can only make the hook ask more.
 * - `ops`: the first operand (word not starting with `-`) must be one of them (`git stash pop`).
 * - `any`: every option passes (programs without options that run code); `deny` is checked on every
 *   word either way (ffmpeg's plugin-loading filters, sips `--js`).
 * - `--` ends the options; a lone `-` is an operand.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function optionsAllowed(words: string[]): boolean {
  interface Spec { s?: string; v?: string; l?: string; n?: boolean; any?: boolean; ops?: string; deny?: RegExp }
  // Options shared by git diff, log and show. Left out: --output, --ext-diff, --textconv (run or
  // write through a program), -O (order file), --no-index (compares files outside the repository),
  // --show-signature (runs gpg).
  const gitDiff = "--stat --numstat --shortstat --dirstat --summary --name-only --name-status --patch --no-patch --raw --patch-with-stat --cached --staged --merge-base --color --no-color --color-words --word-diff --word-diff-regex --unified --minimal --patience --histogram --diff-algorithm --diff-filter --find-renames --find-copies --no-renames --relative --no-relative --ignore-space-change --ignore-all-space --ignore-blank-lines --ignore-space-at-eol --ignore-cr-at-eol --function-context --check --full-index --binary --abbrev --no-abbrev --exit-code --quiet --no-ext-diff --no-textconv --submodule --src-prefix --dst-prefix --no-prefix --text --irreversible-delete --pickaxe-all --pickaxe-regex --stat-width --compact-summary";
  const gitLog = `${gitDiff} --oneline --format --pretty --graph --decorate --no-decorate --all --branches --tags --remotes --author --committer --since --until --after --before --grep --all-match --invert-grep --regexp-ignore-case --extended-regexp --fixed-strings --max-count --skip --reverse --first-parent --no-merges --merges --follow --abbrev-commit --no-abbrev-commit --date --relative-date --full-history --simplify-by-decoration --left-right --cherry-pick --cherry-mark --boundary --topo-order --date-order --author-date-order --no-walk --source --log-size --notes --no-notes --ancestry-path --dense --sparse --parents --children --walk-reflogs --max-parents --min-parents --name-only --expand-tabs --no-expand-tabs`;
  const specs: Record<string, Spec> = {
    "git status": { s: "sbvz", v: "u", l: "--short --branch --porcelain --long --verbose --show-stash --untracked-files --ignored --ignore-submodules --column --no-column --ahead-behind --no-ahead-behind --renames --no-renames --find-renames --null" },
    "git diff": { s: "pusazwWRbcqD", v: "UMCBSGl", l: gitDiff },
    "git log": { s: "pusazwWRbcqDiEFPmrt", v: "nUMCBSG", n: true, l: gitLog },
    "git show": { s: "pusazwWRbcqDm", v: "UMCBSG", n: true, l: `${gitLog} --show-notes` },
    "git rev-parse": { s: "q", l: "--short --verify --quiet --abbrev-ref --symbolic --symbolic-full-name --show-toplevel --show-prefix --show-cdup --git-dir --absolute-git-dir --git-common-dir --git-path --is-inside-work-tree --is-inside-git-dir --is-bare-repository --is-shallow-repository --show-superproject-working-tree --show-object-format --all --branches --tags --remotes --default --sq --sq-quote --not --path-format --local-env-vars --resolve-git-dir --since --until --after --before --revs-only --no-revs --flags --no-flags" },
    "git ls-files": { s: "cdmoiksustvfzr", v: "xX", l: "--cached --deleted --modified --others --ignored --stage --killed --unmerged --directory --no-empty-directory --exclude --exclude-standard --exclude-per-directory --error-unmatch --full-name --recurse-submodules --abbrev --debug --eol --deduplicate --format --sparse --with-tree --resolve-undo --exclude-from" },
    "git blame": { s: "wsetnflpcbk", v: "LMC", l: "--porcelain --line-porcelain --incremental --root --show-stats --date --abbrev --show-name --show-number --show-email --reverse --first-parent --ignore-rev --ignore-revs-file --color-lines --color-by-age --progress --no-progress --minimal --encoding --score-debug" },
    // Left out: -p/-i/-e/--edit (an editor), --pathspec-from-file.
    "git add": { s: "AuvnfNq", l: "--all --update --verbose --dry-run --force --intent-to-add --no-all --ignore-removal --no-ignore-removal --renormalize --ignore-errors --ignore-missing --sparse --chmod --refresh" },
    // Left out: -e/--edit and -c (an editor), -S/--gpg-sign (gpg), -t/--template, -p, --interactive.
    "git commit": { s: "aqvnsoiz", v: "mFC", l: "--message --file --amend --no-edit --all --allow-empty --allow-empty-message --no-verify --verify --signoff --no-signoff --author --date --quiet --verbose --dry-run --only --include --fixup --squash --reset-author --cleanup --trailer --no-gpg-sign --short --porcelain --long --status --no-status --reuse-message --untracked-files --null" },
    // Left out: --edit-description (an editor).
    "git branch": { s: "arvldDmMcCfqtiz", v: "u", l: "--list --all --remotes --verbose --show-current --contains --no-contains --merged --no-merged --sort --format --delete --move --copy --force --set-upstream-to --unset-upstream --track --no-track --points-at --column --no-column --color --no-color --quiet --ignore-case --create-reflog --abbrev --no-abbrev --omit-empty --recurse-submodules" },
    // Left out: -p/--patch, --pathspec-from-file.
    "git checkout": { s: "fqtml", v: "bB", l: "--track --no-track --force --quiet --detach --orphan --ours --theirs --merge --guess --no-guess --progress --no-progress --overwrite-ignore --no-overwrite-ignore --recurse-submodules --no-recurse-submodules --overlay --no-overlay --ignore-other-worktrees --conflict" },
    "git switch": { s: "dftmq", v: "cC", l: "--create --force-create --detach --discard-changes --force --merge --track --no-track --orphan --guess --no-guess --quiet --progress --no-progress --conflict --ignore-other-worktrees --recurse-submodules --no-recurse-submodules" },
    "git restore": { s: "SWqm", v: "s", l: "--source --staged --worktree --ours --theirs --quiet --merge --conflict --ignore-unmerged --overlay --no-overlay --progress --no-progress --recurse-submodules --no-recurse-submodules --ignore-skip-worktree-bits" },
    "git rm": { s: "rfnq", l: "--cached --dry-run --force --quiet --ignore-unmatch --sparse" },
    "git mv": { s: "fknv", l: "--force --dry-run --verbose" },
    "git stash": { s: "uakqpS", v: "m", l: "--include-untracked --all --keep-index --no-keep-index --quiet --message --index --staged --patch --stat --name-only --name-status --no-include-untracked --only-untracked", ops: "list show push pop apply drop save" },
    // Left out: -s/--strategy, -X/--strategy-option (run `git-merge-NAME`), -e/--edit, -S/--gpg-sign.
    "git merge": { s: "nqv", v: "mF", l: "--no-ff --ff --ff-only --squash --no-squash --commit --no-commit --no-edit --abort --continue --quit --message --file --stat --no-stat --log --no-log --quiet --verbose --allow-unrelated-histories --no-verify --verify --signoff --no-signoff --progress --no-progress --autostash --no-autostash --no-gpg-sign --rerere-autoupdate --no-rerere-autoupdate --into-name" },
    // Left out: -s/-u/--sign/--local-user and -v/--verify (gpg), -e/--edit.
    "git tag": { s: "ladfi", v: "nmF", l: "--list --sort --contains --no-contains --points-at --merged --no-merged --format --annotate --message --file --delete --force --column --no-column --ignore-case --no-sign --create-reflog --color --omit-empty" },
    "git worktree": { s: "fnqvz", v: "bB", l: "--force --detach --checkout --no-checkout --lock --porcelain --verbose --dry-run --expire --track --no-track --guess-remote --no-guess-remote --orphan --reason --quiet --relative-paths --no-relative-paths", ops: "list add remove prune move lock unlock repair" },
    // Left out: show/update/prune (they contact the remote), add -f (fetches), --mirror.
    "git remote": { s: "v", v: "tm", l: "--verbose --tags --no-tags --push --all --add --delete", ops: "add get-url rename remove rm set-url set-head" },
    "gh pr": { any: true, deny: /^(?:--editor|-[a-zA-Z]*e)/u, ops: "list view diff checks status create comment edit ready merge close reopen review checkout" },
    "gh issue": { any: true, deny: /^(?:--editor|-[a-zA-Z]*e)/u, ops: "list view create comment edit close reopen status develop" },
    "gh repo view": { any: true },
    "gh run": { any: true, ops: "list view watch rerun download cancel" },
    "gh api": { any: true },
    "gh auth status": { any: true },
    "gh search": { any: true, ops: "code commits issues prs repos" },
    "ls": { any: true }, "cat": { any: true }, "head": { any: true }, "tail": { any: true }, "du": { any: true }, "mkdir": { any: true }, "stat": { any: true },
    "touch": { any: true }, "test": { any: true }, "echo": { any: true }, "printf": { any: true }, "pwd": { any: true },
    // R6-2: tsconfig's outDir/outFile decide where tsc writes, so only `tsc --noEmit` is pre-approved.
    "tsc --noEmit": { any: true }, "jq": { any: true }, "lsof": { any: true }, "trash": { any: true },
    "wc": { s: "lwcmL", l: "--lines --words --bytes --chars --max-line-length --total" },
    "file": { s: "bciIhLzZkNsE0p", l: "--brief --mime --mime-type --mime-encoding --dereference --no-dereference --extension --apple --keep-going --no-pad --special-files --uncompress --print0 --preserve-date" },
    // Left out: --pre, --pre-glob (run a program per file), -z/--search-zip (runs decompressors),
    // -L/--follow (symlinks out of the folder).
    "rg": { s: "nisSwxvclFHhoqUPaNIp0.bu", v: "egftTABCmjrMEd", l: "--files --hidden --no-ignore --no-ignore-vcs --no-ignore-dot --no-ignore-parent --no-ignore-global --no-ignore-exclude --no-ignore-files --ignore-file --glob --iglob --type --type-not --type-list --type-add --ignore-case --smart-case --case-sensitive --word-regexp --line-regexp --invert-match --count --count-matches --files-with-matches --files-without-match --fixed-strings --regexp --after-context --before-context --context --max-count --max-depth --line-number --no-line-number --column --no-column --heading --no-heading --with-filename --no-filename --only-matching --quiet --multiline --multiline-dotall --pcre2 --no-pcre2 --engine --json --no-json --vimgrep --color --colors --sort --sortr --stats --trim --text --unrestricted --null --null-data --replace --max-columns --max-columns-preview --max-filesize --no-messages --passthru --byte-offset --encoding --no-config --one-file-system --threads --binary --no-binary --crlf --path-separator --field-match-separator --field-context-separator --context-separator --pretty --line-buffered --block-buffered --mmap --no-mmap --unicode --no-unicode --include-zero --sort-files --files-without-match --dfa-size-limit --regex-size-limit --auto-hybrid-regex" },
    "grep": { s: "rnicvlLwxEFGHhoqsbaUIzT0", v: "efmABCdD", l: "--recursive --line-number --ignore-case --no-ignore-case --count --files-with-matches --files-without-match --fixed-strings --extended-regexp --basic-regexp --perl-regexp --invert-match --word-regexp --line-regexp --include --exclude --exclude-dir --color --colour --only-matching --quiet --silent --no-filename --with-filename --context --after-context --before-context --max-count --regexp --file --null --null-data --text --binary-files --no-messages --byte-offset --label --initial-tab --line-buffered" },
    // Left out: --compress-program (runs a program), --files0-from.
    "sort": { s: "bdfghiMnrRsuVzcCm", v: "ktoST", l: "--output --key --field-separator --reverse --numeric-sort --unique --human-numeric-sort --ignore-case --general-numeric-sort --month-sort --version-sort --random-sort --random-source --stable --check --merge --zero-terminated --buffer-size --temporary-directory --parallel --batch-size --ignore-leading-blanks --dictionary-order --ignore-nonprinting --debug --sort" },
    // Left out: -K/--config (a config file sets any option), -w/--write-out (`%output{file}` writes a
    // file), --libcurl, -T/--upload-file, -D/--dump-header, -F/--form and --data-urlencode (`name@FILE`
    // sends a file the path check cannot see).
    "curl": { s: "sSfLIivkGgO46JRN", v: "oHXdAmuebcxrCyY", l: "--silent --show-error --fail --fail-with-body --location --head --include --verbose --insecure --output --remote-name --header --request --data --data-raw --data-binary --json --user-agent --max-time --connect-timeout --retry --retry-delay --retry-max-time --user --referer --cookie --cookie-jar --compressed --http1.1 --http2 --get --globoff --proxy --noproxy --url --range --max-filesize --create-dirs --output-dir --no-progress-meter --progress-bar --ipv4 --ipv6 --remote-header-name --oauth2-bearer --speed-limit --speed-time --limit-rate --resolve --cacert --max-redirs" },
    // ladspa, frei0r and lv2 filters load a shared library; an absolute or home path inside a filter
    // value (`ametadata=…:file=/x`, `vidstabdetect=result=/x`, sixth review R6-3) or a tee output
    // (`[f=wav]/x.wav|/y`, seventh review R7-3) is not checked as a path, so it asks, as does any `../`
    // (a URL's `://` does not count).
    "ffmpeg": { any: true, deny: /ladspa|frei0r|lv2|[=,\]|;]['"]?[/~]|:[/~](?!\/)|\.\.[/\\]/iu }, "ffprobe": { any: true, deny: /ladspa|frei0r|lv2|[=,\]|;]['"]?[/~]|:[/~](?!\/)|\.\.[/\\]/iu },
    // `--js` runs JavaScript.
    "sips": { any: true, deny: /^-(?:j|-js)/u },
    "ao-browser": { any: true }, "ao-computer": { any: true }, "ao-sim": { any: true }, "ao-serve list": { any: true }, "ao-serve logs": { any: true }, "ao-serve stop": { any: true },
    "xcrun simctl list": { any: true }, "xcrun simctl boot": { any: true }, "xcrun simctl shutdown": { any: true }, "xcrun simctl io": { any: true }, "xcrun simctl install": { any: true }, "xcrun simctl uninstall": { any: true },
    "xcrun simctl launch": { any: true }, "xcrun simctl terminate": { any: true }, "xcrun simctl get_app_container": { any: true }, "xcrun simctl status_bar": { any: true }, "xcrun simctl ui": { any: true },
  };
  let spec: Spec | undefined;
  let start = 0;
  for (let length = Math.min(3, words.length); length > 0 && !spec; length--) {
    const found = specs[words.slice(0, length).join(" ")];
    if (found) { spec = found; start = length; }
  }
  if (!spec) return false;
  const longs = new Set((spec.l ?? "").split(" ").filter(Boolean));
  let operands = false;
  let first = true;
  for (const word of words.slice(start)) {
    if (spec.deny?.test(word)) return false;
    if (operands || word === "-" || !word.startsWith("-")) {
      if (first && spec.ops && !spec.ops.split(" ").includes(word)) return false;
      first = false;
      continue;
    }
    if (word === "--") { operands = true; continue; }
    if (spec.any) continue;
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      if (!longs.has(eq < 0 ? word : word.slice(0, eq))) return false;
      continue;
    }
    if (spec.n && /^-\d+$/u.test(word)) continue;
    for (let at = 1; at < word.length; at++) {
      const letter = word[at]!;
      if ((spec.v ?? "").includes(letter)) break;
      if (!(spec.s ?? "").includes(letter)) return false;
    }
  }
  return true;
}

/**
 * Whether `target` (absolute, or relative to `cwd`) resolves, through symlinks, into a git directory
 * below `root`: a path component `.git` (any case: macOS folders ignore it). Sixth review R6-1: a
 * line written to `.git/config` (`core.fsmonitor`, `diff.external`, `core.hooksPath`) or a file in
 * `.git/hooks` is run by the next allowed `git status`/`git diff`/`git commit`, so while the
 * workspace switch is off, writes there ask.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function inGitDir(target: string, cwd: string, root: string, host: HookHost): boolean {
  if (!target) return false;
  let current = host.isAbsolute(target) ? host.resolve(target) : host.resolve(cwd, target);
  const rest: string[] = [];
  let real = current;
  for (let depth = 0; depth < 4096; depth++) {
    if (host.exists(current)) {
      try { real = host.join(host.realpath(current), ...rest.reverse()); } catch { return true; }
      break;
    }
    const parent = host.dirname(current);
    if (parent === current) break;
    rest.push(host.basename(current));
    current = parent;
  }
  let rootReal = root;
  try { rootReal = host.realpath(host.resolve(root)); } catch { /* compare with the path as given */ }
  const rel = host.relative(rootReal, real);
  return rel.split(host.sep).some((part) => part.toLowerCase() === ".git");
}

/**
 * Whether git started in `dir` uses only a repository and config the agent could not have changed
 * without a card (sixth review R6-1, seventh review R7-1). Trusted only when all of these hold:
 *
 * - no folder from `dir` up to the one holding `.git` has a `HEAD` entry: git takes any folder with a
 *   `HEAD` file as a git directory, and finds `objects`, `refs` and `config` through its `commondir`
 *   file (R7-1: `ev/HEAD` + `ev/commondir` → `ev2/config` with `diff.external`);
 * - git itself (`git rev-parse`) names a git directory and common directory that are outside `root`
 *   or inside a `.git` folder below it (writes there ask, inGitDir): this covers `gitdir:` files,
 *   worktrees, `commondir`, GIT_DIR and GIT_COMMON_DIR;
 * - every config file git reads (`git config --list --show-origin`: includes, includeIf,
 *   GIT_CONFIG_GLOBAL/SYSTEM) is outside `root` or inside a `.git` folder, none comes from the
 *   command line or environment (GIT_CONFIG_PARAMETERS/COUNT), and `core.hooksPath` is not a folder
 *   inside `root` outside `.git` (husky's `.husky`: its scripts are ordinary project files).
 *
 * Anything git cannot answer (no repository, safe.directory refusal, no git) is not trusted.
 * Not covered: config that names a program inside the folder (`filter.x.clean = ./clean.sh`, an alias
 * running `./x`), hooks that are symlinks into the folder, and config already in place.
 *
 * Self-contained on purpose (its source goes into the hook script).
 */
export function gitRepositoryTrusted(dir: string, root: string, host: HookHost): boolean {
  if (!host.git) return false;
  let current = dir;
  try { current = host.realpath(host.resolve(dir)); } catch { return false; }
  for (let depth = 0; depth < 4096; depth++) {
    if (host.exists(host.join(current, ".git"))) break;
    if (host.exists(host.join(current, "HEAD"))) return false;
    const parent = host.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  let rootReal: string;
  try { rootReal = host.realpath(host.resolve(root)); } catch { return false; }
  const safe = (path: string, base: string): boolean => {
    if (!path) return false;
    let target = host.resolve(base, path);
    const rest: string[] = [];
    for (let depth = 0; depth < 4096; depth++) {
      if (host.exists(target)) {
        try { target = host.join(host.realpath(target), ...rest.reverse()); } catch { return false; }
        break;
      }
      const parent = host.dirname(target);
      if (parent === target) break;
      rest.push(host.basename(target));
      target = parent;
    }
    const rel = host.relative(rootReal, target);
    if (rel.split(host.sep)[0] === ".." || host.isAbsolute(rel)) return true;
    return rel.split(host.sep).some((part) => part.toLowerCase() === ".git");
  };
  const located = host.git(current, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  if (located === undefined) return false;
  const [gitDir, commonDir, topLevel] = located.split("\n");
  if (!gitDir || !commonDir || !safe(gitDir, current) || !safe(commonDir, current)) return false;
  const config = host.git(current, ["config", "--list", "--show-origin", "-z"]);
  if (config === undefined) return false;
  const fields = config.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const origin = fields[at]!;
    const entry = fields[at + 1]!;
    if (!origin.startsWith("file:") || !safe(origin.slice(5), current)) return false;
    const newline = entry.indexOf("\n");
    if (newline > 0 && entry.slice(0, newline).toLowerCase() === "core.hookspath" && !safe(entry.slice(newline + 1), topLevel || current)) return false;
  }
  return true;
}

/**
 * The hook's answer for one Bash command: "allow" (the compound safe set, bashCommandAllowed),
 * "ask" (the user decides on an approval card, even in Claude's own auto mode), or undefined
 * (Claude's own rules decide).
 *
 * With the workspace switch for programs that run code OFF, only two kinds of command are left to
 * Claude's rules: the compound safe set, and ONE simple command of fixed words that starts with a
 * pre-approved program (`git status`, `rg`, `curl` …, supervision.ts DEVELOPMENT_SHELL_PROGRAMS)
 * that uses only the options listed for it (optionsAllowed) and whose file arguments stay inside the
 * folder. Everything else asks: node, python and every program
 * not on the list (perl, a script `./x.sh`), quote fragments, `$(…)`, variables, chains, pipes,
 * redirections, globs. With the switch ON, Claude's auto mode decides unlisted commands as before.
 * Risky forms (riskyWords) ask either way.
 *
 * Uses only the other hook functions (its source goes into the hook script).
 */
export function hookDecision(command: string, cwd: string, root: string, host: HookHost, prefixes: readonly string[]): "allow" | "ask" | undefined {
  if (!command) return undefined;
  const words = staticCommandWords(command);
  if (words ? riskyWords(words) : riskyCommand(command)) return "ask";
  if (root && bashCommandAllowed(command, cwd, root, host)) return "allow";
  if (host.runtimePrograms) return undefined;
  if (!words) return "ask";
  const length = preapprovedPrefix(words, prefixes);
  if (!length || !optionsAllowed(words)) return "ask";
  const args = words.slice(length);
  // gh names API paths (`/repos/x`), not files: its files are `@FILE` values and download folders.
  const ghFiles = () => args.flatMap((arg, at) => arg.includes("@") ? [arg.slice(arg.indexOf("@"))] : arg.startsWith("--dir=") ? [arg.slice(6)] : (arg === "-D" || arg === "--dir") && at + 1 < args.length ? [args[at + 1]!] : /^-D./u.test(arg) ? [arg.slice(2)] : []);
  if (!argumentsStayInside(words[0] === "gh" ? ghFiles() : args, cwd, root, host)) return "ask";
  // R6-1: writes into a git directory, and git in a folder that only looks like a repository.
  const readers = ["git", "cat", "head", "tail", "ls", "rg", "wc", "jq", "file", "stat", "du", "lsof", "echo", "pwd", "ffprobe"];
  if (!readers.includes(words[0]!) && args.some((arg) => [arg, arg.slice(arg.indexOf("=") + 1), arg.replace(/^@/u, "")].some((value) => inGitDir(value, cwd, root, host)))) return "ask";
  if (words[0] === "git" && !gitRepositoryTrusted(cwd, root, host)) return "ask";
  return undefined;
}

/**
 * Self-contained on purpose: its source is written into the hook script, so it may only use its
 * parameters (no imports, no outer names).
 */
export function bashCommandAllowed(command: string, cwd: string, root: string, host: HookHost): boolean {
  // Path-reading programs: every argument is checked as a path (option values after `=` too).
  // Options and subcommands are checked by optionsAllowed (the listed ones only).
  const pathPrograms = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "mkdir", "touch", "test", "sort"]);
  // Programs that never touch files themselves (only through redirections, checked separately).
  const plainPrograms = new Set(["echo", "printf", "true", "false", "pwd"]);
  const gitSubcommands = new Set(["status", "diff", "log", "show", "add", "commit", "rev-parse", "ls-files", "blame", "branch"]);
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
  /**
   * `find` that only lists (fifth review R5-3: most of Claude's cards were plain listings). Start
   * paths and `-newer`/`-samefile` files must stay inside; only listed primaries pass, so -exec,
   * -execdir, -ok, -okdir, -delete, -fprint*, -fls and symlink following (-L, -follow) do not.
   */
  const findAllowed = (args: string[], dirs: Set<string>): boolean => {
    const flags = new Set(["-H", "-P", "-E", "-x", "-s", "-d"]);
    const bare = new Set(["-print", "-print0", "-prune", "-depth", "-empty", "-not", "!", "(", ")", "-o", "-a", "-and", "-or", "-true", "-false", "-ls", "-xdev", "-mount", "-readable", "-writable", "-executable", "-nouser", "-nogroup", "-quit"]);
    const valued = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-perm", "-user", "-group", "-uid", "-gid", "-regex", "-iregex", "-links", "-inum", "-newermt", "-printf", "-regextype"]);
    const files = new Set(["-newer", "-samefile", "-anewer", "-cnewer"]);
    let at = 0;
    while (at < args.length && flags.has(args[at]!)) at++;
    for (; at < args.length && !args[at]!.startsWith("-") && args[at] !== "!" && args[at] !== "("; at++) {
      if (!locate(args[at]!, dirs)) return false;
    }
    for (; at < args.length; at++) {
      const word = args[at]!;
      if (bare.has(word)) continue;
      if (valued.has(word) && at + 1 < args.length) { at++; continue; }
      if (files.has(word) && at + 1 < args.length && locate(args[at + 1]!, dirs)) { at++; continue; }
      return false;
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
  // Eighth review R8-1: a chain is judged once, before it runs, so an earlier step that writes files
  // (`printf … > sub/HEAD`) could change what a later step's check saw (`cd sub && git diff`). A chain
  // passes only when no step writes before another step runs: only its last step may write, and with
  // `|` or a single `&` (steps that run at the same time) no step may write.
  let writes = false; // the current step writes
  let wrote = false; // an earlier step wrote
  let stepAfterWrite = false;
  let concurrent = false;

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
      // The folder must exist now: nothing in a chain that passes can create it.
      if (!found || !found.every((dir) => host.exists(dir))) return false;
      // cd may or may not run (`false && cd x`, subshells, pipelines): keep every possibility.
      for (const dir of found) dirs.add(dir);
      return true;
    }
    if (plainPrograms.has(program)) return true;
    if (pathPrograms.has(program)) {
      // R6-1: the programs here that write (`mkdir`, `touch`, `sort -o`) never write into a git directory.
      if ((program === "mkdir" || program === "touch" || program === "sort") && args.some((arg) => [...dirs].some((dir) => inGitDir(arg.slice(arg.indexOf("=") + 1), dir, rootReal, host)))) return false;
      if (program === "mkdir" || program === "touch" || (program === "sort" && args.some((arg) => arg.startsWith("--output") || /^-[^-]*o/u.test(arg)))) writes = true;
      return optionsAllowed(segment) && pathArgsOk(args, dirs);
    }
    if (program === "git") {
      // Only these leave the worktree as it was; add/commit write the index and objects.
      if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"].includes(args[0] ?? "")) writes = true;
      // `git branch` that only lists (`--show-current`, `-a`, `-vv`) reads; with a name it creates or changes one.
      if (args[0] === "branch") {
        if (!args.slice(1).every((arg) => ["--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color"].includes(arg))) return false;
        writes = false;
      }
    }
    if (program === "git") return gitSubcommands.has(args[0] ?? "") && optionsAllowed(segment) && pathArgsOk(args.slice(1), dirs) && [...dirs].every((dir) => gitRepositoryTrusted(dir, rootReal, host));
    if (program === "find") return findAllowed(args, dirs);
    if (packageManagers.has(program)) {
      if (!host.runtimePrograms) return false;
      writes = true;
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
    if (wrote) stepAfterWrite = true;
    writes = false;
    const dirs = top();
    // Redirections resolve against the directory before this segment's own cd.
    for (const { kind, target } of targets) {
      if (target.text === "/dev/null") continue;
      if (!locate(target.text, dirs)) return false;
      if (kind === "out") writes = true;
      if (kind === "out" && [...dirs].some((dir) => inGitDir(target.text, dir, rootReal, host))) return false;
    }
    const ok = segmentOk(segment, dirs);
    if (writes) wrote = true;
    return ok;
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
      else if (char === "&" || char === "|") concurrent = true;
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
  if (stepAfterWrite || (wrote && concurrent)) return false;
  return segments > 0;
}

/** The PreToolUse hook as a standalone Node script (reads the hook JSON on stdin). */
export function bashHookScript(): string {
  return `// Generated by Sinawi: pre-approves safe Bash commands confined to the worker folder, and asks for the rest (claude-bash-hook.ts hookDecision).
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
const host = {
  resolve: path.resolve, relative: path.relative, isAbsolute: path.isAbsolute, dirname: path.dirname, basename: path.basename, join: path.join, sep: path.sep,
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => { try { fs.lstatSync(p); return true; } catch { return false; } },
  cdpath: process.env.CDPATH || "",
  runtimePrograms: process.argv[3] === "runtime",
  git: (cwd, args) => {
    const result = spawnSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", timeout: 4000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return result.status === 0 ? result.stdout.slice(0, result.stdout.endsWith(String.fromCharCode(10)) ? -1 : undefined) : undefined;
  },
};
const root = process.argv[2];
// Transpilers with keepNames (tsx/esbuild) wrap inner functions in __name(); make it a no-op here.
const __name = (fn) => fn;
// The pre-approved prefixes (supervision.ts DEVELOPMENT_SHELL_PROGRAMS): with the switch off, only a
// simple command of fixed words starting with one of them is left to Claude's rules.
const prefixes = ${JSON.stringify(DEVELOPMENT_SHELL_PROGRAMS)};
${[bashCommandAllowed, optionsAllowed, inGitDir, gitRepositoryTrusted, staticCommandWords, riskyWords, riskyCommand, preapprovedPrefix, argumentsStayInside, hookDecision].map((fn) => fn.toString()).join("\n")}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data && data.tool_name && data.tool_name !== "Bash") {
      // Edit/Write/NotebookEdit (R6-1): while the switch is off, writing into a git directory asks.
      const file = data.tool_input && (data.tool_input.file_path || data.tool_input.notebook_path);
      const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : root;
      if (!host.runtimePrograms && typeof file === "string" && ${inGitDir.name}(file, cwd, root || cwd, host)) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Sinawi: git runs what its config and hooks say (core.fsmonitor, hooks), so writing into a .git folder needs approval while this workspace does not pre-approve programs that run code" } }));
      }
      return;
    }
    const command = data && data.tool_input && typeof data.tool_input.command === "string" ? data.tool_input.command : "";
    const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : root;
    const decision = ${hookDecision.name}(command, cwd, root || "", host, prefixes);
    const reasons = {
      allow: "Sinawi: safe programs confined to the worker folder",
      ask: host.runtimePrograms
        ? "Sinawi: this command reaches outside the project (gh api write, forced or deleting git push, simctl spawn, curl -K, trash outside the folder)"
        : "Sinawi: this workspace pre-approves only simple commands of listed programs with files inside the project; this one runs code, is not on the list, uses an option not listed for it, or cannot be read in advance (quotes glued to text, $(...), variables, chains, pipes, redirections, globs, paths outside)",
    };
    if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reasons[decision] } }));
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
  const hooks = [{ type: "command", command, timeout: 10 }];
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks }, { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks }] } });
}
