// The app window's own key (H1). An Origin header is just text any local program can send, so the
// user's decisions (approving, full access, the MCP token, the live session feed) need something only
// the app window has: a random key that lives in this server's memory, never on disk or in an HTTP
// answer a local program can get.
//
// - Installed app: the Sinawi binary (Tauri) asks for it over GET /api/app-key. The server answers only
//   when the process on the other end of that connection is the app binary that installed it
//   (SINAWI_APP_EXE in the LaunchAgent), then the binary hands it to its main window (`app_key` command).
// - `npm run dev`: scripts/dev.mjs makes a key per run and gives it to this server and to Vite, which puts
//   it in the page it serves. Anything that can load the dev page can read it: dev runs are for development.
//
// The key is removed from process.env at start, so the CLIs this server runs do not inherit it.
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { promisify } from "node:util";

export const APP_KEY_HEADER = "x-sinawi-app";
/** WebSocket subprotocol prefix: a browser cannot set headers on a WebSocket. */
export const APP_KEY_PROTOCOL = "sinawi-app.";

let key: string | undefined;
let appExe: string | undefined;

/** Reads (and removes) SINAWI_APP_KEY / SINAWI_APP_EXE from the environment. */
export function initAppKey(env: NodeJS.ProcessEnv = process.env): void {
  const given = env.SINAWI_APP_KEY;
  key = given && /^[\w-]{32,200}$/u.test(given) ? given : randomBytes(32).toString("base64url");
  delete env.SINAWI_APP_KEY;
  appExe = env.SINAWI_APP_EXE || undefined;
  delete env.SINAWI_APP_EXE;
}

export function appKey(): string {
  if (!key) key = randomBytes(32).toString("base64url");
  return key;
}

function same(given: string): boolean {
  const expected = Buffer.from(appKey());
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The key a request or WebSocket upgrade carries: the header, or a `sinawi-app.<key>` subprotocol. */
export function hasAppKey(headers: IncomingHttpHeaders): boolean {
  const header = headers[APP_KEY_HEADER];
  if (typeof header === "string" && same(header)) return true;
  const protocols = typeof headers["sec-websocket-protocol"] === "string" ? headers["sec-websocket-protocol"].split(",") : [];
  return protocols.some((protocol) => {
    const value = protocol.trim();
    return value.startsWith(APP_KEY_PROTOCOL) && same(value.slice(APP_KEY_PROTOCOL.length));
  });
}

const run = promisify(execFile);

/** The executable of the local process on the other end of a loopback TCP connection (macOS). */
export async function peerExecutable(remotePort: number | undefined): Promise<string | undefined> {
  if (process.platform !== "darwin" || !remotePort) return undefined;
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", `-iTCP@127.0.0.1:${remotePort}`, "-sTCP:ESTABLISHED", "-Fp"], { timeout: 3_000 });
    const pids = [...new Set(stdout.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1))))].filter((pid) => pid > 0 && pid !== process.pid);
    if (pids.length !== 1) return undefined;
    const { stdout: comm } = await run("/bin/ps", ["-o", "comm=", "-p", String(pids[0])], { timeout: 3_000 });
    return comm.trim() || undefined;
  } catch { return undefined; }
}

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** Whether `executable` is the app binary this server was installed by. */
export function isAppExecutable(executable: string | undefined, expected = appExe): boolean {
  return Boolean(executable && expected && real(executable) === real(expected));
}
