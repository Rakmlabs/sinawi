/**
 * Loaded before every test file (`npm test`: `node --import ./server/test-guard.ts`). Tests must never
 * reach the owner's running app or data (PR #8 review P8-2, tenth review R10-2): a CLI whose HTTP call
 * failed fell back to the shared queue folder the installed app watches, and paths that default to
 * the home folder or the per-user temp folder are the installed app's too.
 *
 * - HOME, TMPDIR, SINAWI_DATA_DIR and SINAWI_COMPUTER_DIR point into one fresh temporary folder, for
 *   this process and every child it starts: an `env` given to child_process without them, or with a
 *   path outside that folder, gets them too.
 * - A child without SINAWI_PORT gets a closed port (its CLIs would dial 3001), and one with 3001 throws.
 * - A connection to port 3001 (the installed app's) throws.
 * - If any of these still resolves to the owner's real folders, loading fails and no test runs.
 */
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const APP_PORT = 3001;
const realHome = userInfo().homedir || homedir();
const realTmp = realpathSync(tmpdir());
const darwinTmp = (() => {
  if (process.platform !== "darwin") return undefined;
  try { return realpathSync(childProcess.execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim()); } catch { return undefined; }
})();
const uid = process.getuid ? process.getuid() : 0;
/** What the installed app owns: its data, its queues, the CLIs it installs. */
const owned = [
  join(realHome, "Library", "Application Support"), join(realHome, "Library", "LaunchAgents"), join(realHome, ".sinawi"), join(realHome, ".local", "bin"),
  join(realTmp, "sinawi-browser"), join(realTmp, `sinawi-computer-${uid}`), "/tmp/sinawi-browser", "/private/tmp/sinawi-browser",
  ...(darwinTmp ? [join(darwinTmp, "sinawi-browser"), join(darwinTmp, `sinawi-computer-${uid}`)] : []),
];
const inside = (path: string, folder: string) => { const rel = relative(folder, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

// The test runner's own process loads this first; the test files it starts inherit its folder.
const inherited = process.env.SINAWI_TEST_GUARD;
const root = inherited && existsSync(inherited) ? inherited : realpathSync(mkdtempSync(join(realTmp, "sinawi-test-")));
const guarded = {
  HOME: join(root, "home"),
  TMPDIR: join(root, "tmp"),
  SINAWI_DATA_DIR: join(root, "data"),
  SINAWI_COMPUTER_DIR: join(root, "computer"),
  SINAWI_TEST_GUARD: root,
};
for (const value of [guarded.HOME, guarded.TMPDIR, guarded.SINAWI_DATA_DIR, guarded.SINAWI_COMPUTER_DIR]) mkdirSync(value, { recursive: true });
// The guarded home has no git identity of the owner's: commits in test repositories use this one.
if (root !== inherited) writeFileSync(join(guarded.HOME, ".gitconfig"), "[user]\n\tname = Sinawi Test\n\temail = test@sinawi.invalid\n");
delete process.env.AGENT_ORCHESTRA_DATA_DIR;
delete process.env.AGENT_ORCHESTRA_PORT;
Object.assign(process.env, guarded);
if (root !== inherited) process.on("exit", () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

for (const [name, path] of [["tmpdir()", tmpdir()], ["homedir()", homedir()], ["SINAWI_DATA_DIR", process.env.SINAWI_DATA_DIR!], ["SINAWI_COMPUTER_DIR", process.env.SINAWI_COMPUTER_DIR!]] as const) {
  if (!inside(path, root) || owned.some((folder) => inside(path, folder))) throw new Error(`test guard: ${name} is ${path}, not inside ${root}`);
}

// A child given its own env still gets the guarded paths (it would otherwise find the real ones).
type Fn = (...args: unknown[]) => unknown;
const childEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(guarded)) if (!merged[key] || !isAbsolute(merged[key]!) || !inside(merged[key]!, root)) merged[key] = value;
  // Nothing listens on port 9: a CLI whose test gave it no port fails instead of reaching the app.
  merged.SINAWI_PORT ||= "9";
  if (merged.SINAWI_PORT === String(APP_PORT) || merged.AGENT_ORCHESTRA_PORT === String(APP_PORT)) throw new Error(`test guard: a child was given port ${APP_PORT}, the installed app's`);
  return merged;
};
/** The arguments with the options object guarded (added where the caller gave none). */
const guardArgs = (args: unknown[]): unknown[] => {
  const out = [...args];
  const at = Array.isArray(out[1]) ? 2 : 1;
  const options = out[at];
  if (options && typeof options === "object" && !Array.isArray(options)) out[at] = { ...options, env: childEnv((options as { env?: NodeJS.ProcessEnv }).env) };
  else out.splice(at, 0, { env: childEnv() });
  return out;
};
const cp = childProcess as unknown as Record<string, Fn>;
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[name]! as Fn & { [promisify.custom]?: Fn };
  const wrapped = function guardedChildProcess(this: unknown, ...args: unknown[]) { return original.apply(this, guardArgs(args)); } as Fn & { [promisify.custom]?: Fn };
  // promisify(execFile) resolves to { stdout, stderr } through this; keep it, guarded too.
  const custom = original[promisify.custom];
  if (custom) wrapped[promisify.custom] = (...args: unknown[]) => custom(...guardArgs(args));
  cp[name] = wrapped;
}

const connect = net.Socket.prototype.connect as unknown as Fn;
(net.Socket.prototype as unknown as { connect: Fn }).connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { port?: unknown } | number | string | unknown[] | undefined;
  const options = Array.isArray(first) ? first[0] as { port?: unknown } : first;
  const port = typeof options === "object" && options ? Number(options.port) : Number(options);
  if (port === APP_PORT) throw new Error(`test guard: a test connected to port ${APP_PORT}, the installed app's`);
  return connect.apply(this, args);
};
syncBuiltinESMExports();
