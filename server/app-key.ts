// The app window's own key (H1). An Origin header is just text any local program can send, so the
// user's decisions (approving, full access, the MCP token, the live session feed) need something only
// the app window has: a random key that lives in this server's memory. No HTTP route hands it out.
//
// - Installed app: the server listens on a unix socket in a folder only this user can enter
//   (`<data>/run/app-key.sock`). For every connection it runs the app binary it was installed by
//   (SINAWI_APP_EXE) with `--sinawi-check-peer`, handing it the connection. The binary asks the kernel
//   who connected (LOCAL_PEERTOKEN, the audit token recorded at connect time) and lets the key go only
//   when that process's code satisfies the binary's own designated code requirement (its signature),
//   checked with the Security framework (src-tauri/src/peer_check.rs). A process name, a path or
//   argv[0] play no part, so `exec -a <app path> curl …` gets nothing; a process that connects and then
//   execs the real app no longer matches the recorded token; a replaced binary fails its signature.
// - `npm run dev`: scripts/dev.mjs makes a key per run and hands it to this server over an inherited
//   pipe (SINAWI_APP_KEY_FD), never in the environment (`ps -E` shows that), and to the developer as a
//   link whose #fragment carries it; the page served by Vite does not contain it.
//
// What this does not stop, honestly: anything running as the same macOS user can change the files this
// server runs from (the app bundle, the copied server, the LaunchAgent plist) and restart it, or read
// the key out of a dev terminal's scrollback. Keeping a same-user agent out of that needs the agent's
// process sandboxed (macOS sandbox or a separate user); see README "App window key".
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

export const APP_KEY_HEADER = "x-sinawi-app";
/** WebSocket subprotocol prefix: a browser cannot set headers on a WebSocket. */
export const APP_KEY_PROTOCOL = "sinawi-app.";
/** The flag the app binary answers as the peer checker (src-tauri/src/main.rs). */
export const PEER_CHECK_FLAG = "--sinawi-check-peer";

let key: string | undefined;
let appExe: string | undefined;

function readAndClose(fd: number): string {
  try { return readFileSync(fd, "utf8"); } finally { try { closeSync(fd); } catch { /* already closed */ } }
}

const valid = (value: string | undefined): value is string => Boolean(value && /^[\w-]{32,200}$/u.test(value));

/**
 * Takes the key dev.mjs handed over on an inherited pipe (SINAWI_APP_KEY_FD) and the app binary's path
 * (SINAWI_APP_EXE), then removes both from the environment so the CLIs this server runs inherit neither.
 * Without a handed-over key, a random one is made.
 */
export function initAppKey(env: NodeJS.ProcessEnv = process.env, take: (fd: number) => string = readAndClose): void {
  let given: string | undefined;
  const fd = Number(env.SINAWI_APP_KEY_FD);
  if (Number.isInteger(fd) && fd >= 3) {
    try { given = take(fd).trim(); } catch { /* no pipe: a random key below */ }
  }
  delete env.SINAWI_APP_KEY_FD;
  key = valid(given) ? given : randomBytes(32).toString("base64url");
  appExe = env.SINAWI_APP_EXE || undefined;
  delete env.SINAWI_APP_EXE;
}

export function appKey(): string {
  if (!key) key = randomBytes(32).toString("base64url");
  return key;
}

/** The app binary this server was installed by, when it was (the LaunchAgent sets it). */
export function appExecutable(): string | undefined { return appExe; }

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

/** Decides whether the process on the other end of a key-socket connection is the app. */
export type PeerCheck = (connection: Socket) => Promise<boolean>;

/** Runs the app binary as the checker, with the connection as its fd 3; exit 0 means "the app". */
export function appBinaryPeerCheck(executable: string, timeoutMs = 10_000): PeerCheck {
  return (connection) => new Promise((resolve) => {
    // The raw descriptor, not the Socket: handing node the Socket object as stdio trips a libuv
    // assertion (kqueue) when the connection closes afterwards.
    const fd = (connection as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (typeof fd !== "number" || fd < 0) { resolve(false); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [PEER_CHECK_FLAG], { stdio: ["ignore", "ignore", "ignore", fd], timeout: timeoutMs, env: { PATH: "/usr/bin:/bin" } });
    } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

/** `<data>/run/app-key.sock`: the folder is the user's alone (0700), the socket too (0600). */
export function appKeySocketPath(dataDir: string): string { return join(dataDir, "run", "app-key.sock"); }

/**
 * Serves the key on a unix socket to connections `check` accepts; others are closed with nothing sent.
 * Resolves to a function that stops serving and removes the socket.
 */
export async function serveAppKey(socketPath: string, check: PeerCheck): Promise<() => Promise<void>> {
  // A unix socket path longer than this cannot be bound on macOS.
  if (Buffer.byteLength(socketPath) > 103) throw new Error(`app key socket path is too long: ${socketPath}`);
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(socketPath, { force: true });
  const open = new Set<Socket>();
  const server: Server = createServer((connection) => {
    open.add(connection);
    connection.on("close", () => open.delete(connection));
    connection.on("error", () => undefined);
    void check(connection).then(
      (ok) => { if (ok && !connection.destroyed) connection.end(`${appKey()}\n`); else connection.destroy(); },
      () => connection.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  return () => new Promise<void>((resolve) => {
    server.close(() => { rmSync(socketPath, { force: true }); resolve(); });
    for (const connection of open) connection.destroy();
  });
}
