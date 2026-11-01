import { execFile as nodeExecFile } from "node:child_process";
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Express, Request, Response } from "express";
import { WebSocketServer } from "ws";
import { isAllowedOrigin } from "./origin-policy.js";

// The server is bundled as CommonJS, where esbuild cannot preserve import.meta.url.
// __filename points at server.cjs in the app bundle and at this module under tsx.
const require = createRequire(typeof __filename === "string" ? __filename : (process.argv[1] ?? join(process.cwd(), "package.json")));
const OPEN = 1;
const DEFAULT_BUFFER_BYTES = 200 * 1024;
const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;

export interface Disposable { dispose(): void }

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess | Promise<PtyProcess>;

export interface TerminalClient {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  pid: number;
  alive: boolean;
}

interface TerminalSession extends TerminalSessionInfo {
  pty: PtyProcess;
  clients: Set<TerminalClient>;
  output: Buffer;
  cleanupTimer?: NodeJS.Timeout;
  disposables: Disposable[];
}

interface PendingTerminalSession {
  id: string;
  clients: Set<TerminalClient>;
  cancelled: boolean;
  promise: Promise<TerminalSession>;
}

interface ManagerOptions {
  ptyFactory?: PtyFactory;
  maxBufferBytes?: number;
  inactivityMs?: number;
  schedule?: (callback: () => void, delay: number) => NodeJS.Timeout;
  cancelSchedule?: (timer: NodeJS.Timeout) => void;
  homeDir?: string;
  onError?: (message: string) => void | Promise<void>;
}

function clampDimension(value: number, fallback: number, max: number) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data && typeof data === "object" && "toString" in data) return String(data);
  return "";
}

async function existingDirectory(requested: string | undefined, fallback: string): Promise<string> {
  if (!requested) return fallback;
  try {
    return (await stat(requested)).isDirectory() ? requested : fallback;
  } catch {
    return fallback;
  }
}

async function loadNodePty(): Promise<{ spawn: PtyFactory }> {
  try {
    const packageJson = require.resolve("node-pty/package.json");
    const packageDir = dirname(packageJson);
    await Promise.all([
      chmod(join(packageDir, "prebuilds/darwin-arm64/spawn-helper"), 0o755).catch(() => undefined),
      chmod(join(packageDir, "prebuilds/darwin-x64/spawn-helper"), 0o755).catch(() => undefined),
    ]);
    return require("node-pty") as { spawn: PtyFactory };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`통합 터미널을 시작할 수 없습니다. node-pty 로드 실패: ${detail}`);
  }
}

let nodePtyPromise: Promise<{ spawn: PtyFactory }> | undefined;
const defaultPtyFactory: PtyFactory = async (file, args, options) => {
  nodePtyPromise ??= loadNodePty();
  return (await nodePtyPromise).spawn(file, args, options);
};

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly pending = new Map<string, PendingTerminalSession>();
  private readonly ptyFactory: PtyFactory;
  private readonly maxBufferBytes: number;
  private readonly inactivityMs: number;
  private readonly schedule: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly cancelSchedule: (timer: NodeJS.Timeout) => void;
  private readonly homeDir: string;
  private readonly onError?: ManagerOptions["onError"];
  private closed = false;

  constructor(options: ManagerOptions = {}) {
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_BUFFER_BYTES;
    this.inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
    this.homeDir = options.homeDir ?? homedir();
    this.onError = options.onError;
  }

  async attach(id: string, client: TerminalClient, input: { cwd?: string; cols: number; rows: number }): Promise<TerminalSessionInfo> {
    let session = this.sessions.get(id);
    if (session) return this.attachToSession(session, client);
    if (this.closed) throw new Error("터미널 관리자가 종료되었습니다.");

    let pending = this.pending.get(id);
    if (!pending || pending.cancelled) pending = this.startPending(id, input);
    pending.clients.add(client);
    let disconnected = false;
    const disconnectPending = () => {
      if (session) return;
      if (disconnected) return;
      disconnected = true;
      pending!.clients.delete(client);
      if (!pending!.clients.size) this.cancelPending(pending!);
    };
    client.on("close", disconnectPending);
    client.on("error", disconnectPending);

    session = await pending.promise;
    if (disconnected || client.readyState !== OPEN) {
      this.scheduleCleanup(session);
      throw new Error("터미널 시작이 취소되었습니다.");
    }
    return this.attachToSession(session, client);
  }

  private attachToSession(session: TerminalSession, client: TerminalClient): TerminalSessionInfo {
    if (session.cleanupTimer) {
      this.cancelSchedule(session.cleanupTimer);
      session.cleanupTimer = undefined;
    }
    session.clients.add(client);
    client.on("message", (data) => this.handleMessage(session!, data));
    const detach = () => this.detach(session!, client);
    client.on("close", detach);
    client.on("error", detach);
    client.send(JSON.stringify({ type: "ready", id: session.id, cwd: session.cwd }));
    if (session.output.length) client.send(session.output.toString("utf8"));
    return this.info(session);
  }

  private startPending(id: string, input: { cwd?: string; cols: number; rows: number }): PendingTerminalSession {
    const pending: PendingTerminalSession = { id, clients: new Set(), cancelled: false, promise: undefined! };
    this.pending.set(id, pending);
    pending.promise = this.spawn(id, input).then((session) => {
      if (pending.cancelled || this.closed || this.pending.get(id) !== pending) {
        this.destroySession(session);
        throw new Error("터미널 시작이 취소되었습니다.");
      }
      this.sessions.set(id, session);
      return session;
    }).finally(() => {
      if (this.pending.get(id) === pending) this.pending.delete(id);
    });
    return pending;
  }

  private cancelPending(pending: PendingTerminalSession) {
    pending.cancelled = true;
    if (this.pending.get(pending.id) === pending) this.pending.delete(pending.id);
  }

  private async spawn(id: string, input: { cwd?: string; cols: number; rows: number }): Promise<TerminalSession> {
    const cwd = await existingDirectory(input.cwd, this.homeDir);
    const cols = clampDimension(input.cols, 80, 500);
    const rows = clampDimension(input.rows, 24, 300);
    const shell = process.env.SHELL || "/bin/zsh";
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.LANG ||= "ko_KR.UTF-8";
    try {
      const pty = await this.ptyFactory(shell, ["-l"], { cwd, cols, rows, env });
      const session: TerminalSession = { id, cwd, pid: pty.pid, alive: true, pty, clients: new Set(), output: Buffer.alloc(0), disposables: [] };
      session.disposables.push(pty.onData((data) => this.onData(session, data)));
      session.disposables.push(pty.onExit(({ exitCode }) => this.onExit(session, exitCode)));
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportError(message);
      throw new Error(message);
    }
  }

  private reportError(message: string) {
    try {
      void Promise.resolve(this.onError?.(message)).catch(() => undefined);
    } catch {
      // Notification delivery must not mask the terminal startup error.
    }
  }

  private handleMessage(session: TerminalSession, raw: unknown) {
    if (!session.alive) return;
    try {
      const message = JSON.parse(messageText(raw)) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      if (message.type === "input" && typeof message.data === "string") session.pty.write(message.data);
      if (message.type === "resize") {
        const cols = clampDimension(Number(message.cols), 80, 500);
        const rows = clampDimension(Number(message.rows), 24, 300);
        session.pty.resize(cols, rows);
      }
    } catch {
      // Ignore malformed client frames; terminal output must remain usable.
    }
  }

  private onData(session: TerminalSession, data: string) {
    const next = Buffer.concat([session.output, Buffer.from(data)]);
    session.output = next.length > this.maxBufferBytes ? next.subarray(next.length - this.maxBufferBytes) : next;
    for (const client of session.clients) if (client.readyState === OPEN) client.send(data);
  }

  private onExit(session: TerminalSession, code: number) {
    session.alive = false;
    const message = JSON.stringify({ type: "exit", code });
    for (const client of session.clients) if (client.readyState === OPEN) client.send(message);
    if (!session.clients.size) this.scheduleCleanup(session);
  }

  private detach(session: TerminalSession, client: TerminalClient) {
    if (!session.clients.delete(client) || session.clients.size) return;
    this.scheduleCleanup(session);
  }

  private scheduleCleanup(session: TerminalSession) {
    if (session.clients.size || session.cleanupTimer || this.sessions.get(session.id) !== session) return;
    session.cleanupTimer = this.schedule(() => this.delete(session.id), this.inactivityMs);
    session.cleanupTimer.unref?.();
  }

  run(id: string, command: string): TerminalSessionInfo {
    const session = this.sessions.get(id);
    if (!session?.alive) throw new Error("실행 중인 터미널 탭을 찾을 수 없습니다.");
    if (!command.trim() || command.length > 100_000) throw new Error("실행할 명령이 올바르지 않습니다.");
    session.pty.write(`${command}\r`);
    return this.info(session);
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    const pending = this.pending.get(id);
    if (pending) this.cancelPending(pending);
    if (!session) return Boolean(pending);
    this.sessions.delete(id);
    if (session.cleanupTimer) this.cancelSchedule(session.cleanupTimer);
    for (const disposable of session.disposables) disposable.dispose();
    if (session.alive) session.pty.kill();
    session.alive = false;
    for (const client of session.clients) client.close(1001, "터미널 세션이 종료되었습니다.");
    session.clients.clear();
    return true;
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) this.cancelPending(pending);
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }

  private destroySession(session: TerminalSession) {
    for (const disposable of session.disposables) disposable.dispose();
    if (session.alive) session.pty.kill();
    session.alive = false;
  }

  private info(session: TerminalSession): TerminalSessionInfo {
    return { id: session.id, cwd: session.cwd, pid: session.pid, alive: session.alive };
  }
}

export function isTerminalRequestAllowed(remoteAddress: string | undefined, origin: string | undefined): boolean {
  const loopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  return loopback && typeof origin === "string" && isAllowedOrigin(origin);
}

function routeId(req: Request) {
  const raw = req.params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || id.length > 200) throw new Error("터미널 탭 ID가 올바르지 않습니다.");
  return id;
}

export interface TerminalServiceOptions extends ManagerOptions {
  execFile?: (file: string, args: string[], callback: (error: Error | null) => void) => unknown;
}

export function createTerminalService(options: TerminalServiceOptions = {}) {
  const manager = new TerminalSessionManager(options);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const execFile = options.execFile ?? nodeExecFile;

  websocket.on("connection", (client, request) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const id = url.searchParams.get("id") ?? "";
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const cols = Number(url.searchParams.get("cols"));
    const rows = Number(url.searchParams.get("rows"));
    if (!id || id.length > 200) {
      client.close(1008, "터미널 탭 ID가 필요합니다.");
      return;
    }
    manager.attach(id, client, { cwd, cols, rows }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (client.readyState === OPEN) client.send(JSON.stringify({ type: "error", message }));
      client.close(1011, "터미널 시작 실패");
    });
  });

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/api/terminal/ws") return false;
    if (!isTerminalRequestAllowed(request.socket.remoteAddress, request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, request));
    return true;
  };

  const registerRoutes = (app: Express) => {
    app.get("/api/terminal", (_req, res) => res.json(manager.list()));
    app.delete("/api/terminal/:id", (req, res) => {
      try { res.status(manager.delete(routeId(req)) ? 204 : 404).end(); }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
    app.post("/api/terminal/:id/run", (req, res) => {
      try {
        if (typeof req.body?.command !== "string") throw new Error("실행할 명령이 올바르지 않습니다.");
        res.json(manager.run(routeId(req), req.body.command));
      }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
    });
    app.post("/api/terminal/external", async (req: Request, res: Response) => {
      const cwd = await existingDirectory(typeof req.body?.cwd === "string" ? req.body.cwd : undefined, homedir());
      execFile("open", ["-a", "Terminal", cwd], (error) => {
        if (error) res.status(500).json({ error: "외부 터미널을 열 수 없습니다." });
        else res.status(204).end();
      });
    });
  };

  const close = () => {
    manager.close();
    for (const client of websocket.clients) client.close(1001, "서버를 종료합니다.");
    websocket.close();
  };

  return { manager, websocket, registerRoutes, handleUpgrade, close };
}

export function registerTerminalService(httpServer: HttpServer, app: Express, options: TerminalServiceOptions = {}) {
  const service = createTerminalService(options);
  service.registerRoutes(app);
  httpServer.on("upgrade", service.handleUpgrade);
  return service;
}
