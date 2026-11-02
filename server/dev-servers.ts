import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * Long-running dev servers an agent asks Sinawi to run (`ao-serve`). An agent CLI ends its own
 * background shells when it exits (Claude stops every run_in_background task, and `cmd &` is
 * refused headless), so a dev server started by a worker died with the worker. The app owns these
 * instead, like Claude Code's preview servers: they outlive the run and end with the session.
 */
export interface DevServer {
  sessionId: string;
  name: string;
  command: string;
  cwd: string;
  port?: number;
  pid: number;
  log: string;
  startedAt: string;
}

export interface DevServerView extends DevServer { alive: boolean }

export interface StartInput { name: string; command: string; cwd: string; port?: number; restart?: boolean }

export type StartResult =
  | { ok: true; server: DevServerView; reused: boolean; ready: boolean; tail: string }
  | { ok: false; error: string; tail?: string };

const NAME = /^[\w.-]{1,40}$/u;

export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  const attempt = (host: string) => new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  return Promise.all([attempt("127.0.0.1"), attempt("::1")]).then((results) => results.some(Boolean));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function tail(path: string, lines = 30): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").slice(-lines - 1).join("\n").trim();
}

export class DevServerManager {
  private servers = new Map<string, DevServer>();

  constructor(private opts: {
    logDir: string;
    env: () => NodeJS.ProcessEnv;
    onEvent?: (sessionId: string, text: string) => void;
    readyMs?: number;
    settleMs?: number;
  }) {}

  private key(sessionId: string, name: string) { return `${sessionId}\u0000${name}`; }

  private view(server: DevServer): DevServerView { return { ...server, alive: alive(server.pid) }; }

  list(sessionId: string): DevServerView[] {
    return [...this.servers.values()].filter((server) => server.sessionId === sessionId).map((server) => this.view(server));
  }

  async start(sessionId: string, input: StartInput): Promise<StartResult> {
    const name = input.name.trim();
    const command = input.command.trim();
    if (!NAME.test(name)) return { ok: false, error: "이름은 영문·숫자·.-_ 로 40자 이내입니다. 예: ao-serve start web --port 5173 -- pnpm dev" };
    if (!command) return { ok: false, error: "실행할 명령이 없습니다. 예: ao-serve start web --port 5173 -- pnpm dev" };
    const existing = this.servers.get(this.key(sessionId, name));
    if (existing && alive(existing.pid)) {
      if (!input.restart) return { ok: true, server: this.view(existing), reused: true, ready: existing.port ? await portOpen(existing.port) : true, tail: await tail(existing.log) };
      await this.stop(sessionId, name);
    }
    if (input.port && await portOpen(input.port)) {
      return { ok: false, error: `${input.port} 포트를 이미 다른 프로세스가 쓰고 있습니다. 그 서버를 그대로 쓰거나(ao-browser goto ${input.port}) 다른 포트로 띄우세요.` };
    }
    mkdirSync(this.opts.logDir, { recursive: true });
    const log = join(this.opts.logDir, `${sessionId.slice(0, 8)}-${name}.log`);
    const fd = openSync(log, "w");
    let child;
    try {
      // Own process group: stop() ends the dev server and everything it started (turbo, vite, …).
      child = spawn("/bin/sh", ["-c", command], { cwd: input.cwd, env: this.opts.env(), detached: true, stdio: ["ignore", fd, fd] });
    } catch (error) {
      return { ok: false, error: `실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      closeSync(fd);
    }
    const pid = child.pid;
    if (!pid) return { ok: false, error: "실행하지 못했습니다 (pid 없음).", tail: await tail(log) };
    child.on("error", () => undefined);
    child.unref();
    const server: DevServer = { sessionId, name, command, cwd: input.cwd, port: input.port, pid, log, startedAt: new Date().toISOString() };
    this.servers.set(this.key(sessionId, name), server);
    const ready = await this.waitReady(server);
    if (!alive(pid)) {
      this.servers.delete(this.key(sessionId, name));
      return { ok: false, error: "서버가 바로 종료되었습니다. 아래 로그를 보고 명령을 고치세요.", tail: await tail(log) };
    }
    this.opts.onEvent?.(sessionId, `개발 서버 실행: ${name}${server.port ? ` (포트 ${server.port})` : ""} — ${command}`);
    return { ok: true, server: this.view(server), reused: false, ready, tail: await tail(log) };
  }

  /** With a port: until it accepts connections. Without: a short settle so an instant crash shows. */
  private async waitReady(server: DevServer): Promise<boolean> {
    const deadline = Date.now() + (server.port ? this.opts.readyMs ?? 90_000 : this.opts.settleMs ?? 3_000);
    while (Date.now() < deadline) {
      if (!alive(server.pid)) return false;
      if (server.port && await portOpen(server.port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return !server.port && alive(server.pid);
  }

  async logs(sessionId: string, name: string, lines = 80): Promise<string | undefined> {
    const server = this.servers.get(this.key(sessionId, name));
    return server ? tail(server.log, Math.min(Math.max(lines, 1), 500)) : undefined;
  }

  async stop(sessionId: string, name: string): Promise<boolean> {
    const server = this.servers.get(this.key(sessionId, name));
    if (!server) return false;
    this.servers.delete(this.key(sessionId, name));
    await killGroup(server.pid);
    return true;
  }

  stopSession(sessionId: string): void {
    for (const server of this.list(sessionId)) void this.stop(sessionId, server.name);
  }

  /** Server shutdown: nothing may keep a port after the app's server is gone. */
  stopAll(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const server of this.servers.values()) { try { process.kill(-server.pid, signal); } catch { /* gone */ } }
    if (signal === "SIGKILL") this.servers.clear();
  }
}

async function killGroup(pid: number): Promise<void> {
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  for (let waited = 0; waited < 3_000; waited += 100) {
    try { process.kill(-pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

/** Dev servers watch files and hot-reload; CI makes Expo/Metro (and others) stop watching. */
export function devServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CI;
  return next;
}
