import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Generic install locations (all $HOME-relative or system-wide), checked after the user's PATH. */
export function knownCliDirs(home = homedir()): string[] {
  return [
    join(home, ".local/bin"), join(home, ".grok/bin"), join(home, ".claude/local"), join(home, ".npm-global/bin"),
    join(home, ".bun/bin"), join(home, ".volta/bin"), join(home, ".n/bin"), join(home, "Library/pnpm"),
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin", join(home, "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"),
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin",
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  ];
}

let loginPath: string | undefined;
/** PATH from the user's login shell, read once (GUI-launched apps get a minimal launchd PATH). */
export function loginShellPath(): string {
  if (loginPath !== undefined) return loginPath;
  loginPath = "";
  if (process.platform === "win32") return loginPath;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-lc", "printf '__AO__%s' \"$PATH\""], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    loginPath = out.split("__AO__").pop()?.trim() ?? "";
  } catch { /* keep the process PATH */ }
  return loginPath;
}

let npmBin: string | undefined;
function npmGlobalBin(path: string): string {
  if (npmBin !== undefined) return npmBin;
  npmBin = "";
  try { npmBin = join(execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 3000, env: { ...process.env, PATH: path }, stdio: ["ignore", "pipe", "ignore"] }).trim(), "bin"); } catch { /* npm missing */ }
  return npmBin;
}

/** Process PATH + login shell PATH + known locations, deduplicated, `~` expanded. */
export function searchDirs(env: NodeJS.ProcessEnv = process.env, home = homedir(), extra: string[] = [loginShellPath()]): string[] {
  const dirs = [env.PATH ?? "", ...extra].flatMap((value) => value.split(delimiter)).filter(Boolean).map((dir) => dir.startsWith("~/") ? join(home, dir.slice(2)) : dir);
  const all = [...dirs, ...knownCliDirs(home)];
  return [...new Set(all)];
}

export function fullPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dirs = searchDirs(env, home);
  const npm = npmGlobalBin(dirs.join(delimiter));
  return [...new Set(npm ? [...dirs, npm] : dirs)].join(delimiter);
}

function executable(file: string): boolean {
  try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/** Absolute path of a CLI, or undefined. A filesystem lookup: no spawn, so a slow `--version` can't hide it. */
export function resolveCli(name: string, dirs: string[] = fullPath().split(delimiter)): string | undefined {
  if (isAbsolute(name)) return executable(name) ? name : undefined;
  for (const dir of dirs) { const file = join(dir, name); if (executable(file)) return file; }
  return undefined;
}
