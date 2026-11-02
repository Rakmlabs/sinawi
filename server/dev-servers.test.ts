import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { clearComputerTokens, issueComputerToken } from "./computer-tokens.js";
import { DevServerManager, portOpen } from "./dev-servers.js";
import { parseServeArgv, registerServeRoutes, SERVE_CLI_SOURCE } from "./serve-tool.js";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), "sinawi-serve-"));
  const notes: string[] = [];
  const devServers = new DevServerManager({ logDir: join(dir, "logs"), env: () => process.env, onEvent: (_id, text) => notes.push(text), readyMs: 15_000, settleMs: 300 });
  return { dir, devServers, notes };
}

test("an app-owned dev server waits for its port, is reused by name, and stops with its group", async () => {
  const { dir, devServers, notes } = await manager();
  const port = await freePort();
  try {
    const started = await devServers.start("s1", { name: "web", command: `python3 -m http.server ${port} --bind 127.0.0.1`, cwd: dir, port });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.ready, true);
    assert.equal(await portOpen(port), true);
    assert.match(notes[0], /개발 서버 실행: web \(포트 \d+\)/);
    const again = await devServers.start("s1", { name: "web", command: "ignored", cwd: dir, port });
    assert.equal(again.ok && again.reused, true, "the same name is reused, not started twice");
    assert.deepEqual(devServers.list("s1").map((server) => [server.name, server.alive]), [["web", true]]);
    assert.deepEqual(devServers.list("s2"), [], "another session does not see it");
    assert.equal(await devServers.stop("s1", "web"), true);
    assert.equal(await portOpen(port), false);
  } finally {
    devServers.stopAll("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dev server that exits at once reports its log; a busy port is refused", async () => {
  const { dir, devServers } = await manager();
  const busy = createNetServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => busy.once("listening", resolve));
  const port = (busy.address() as { port: number }).port;
  try {
    const crashed = await devServers.start("s1", { name: "bad", command: "echo 설정 파일이 없습니다 >&2; exit 3", cwd: dir });
    assert.equal(crashed.ok, false);
    assert.match(!crashed.ok ? crashed.tail ?? "" : "", /설정 파일이 없습니다/);
    const taken = await devServers.start("s1", { name: "web", command: "sleep 30", cwd: dir, port });
    assert.equal(taken.ok, false);
    assert.match(!taken.ok ? taken.error : "", /이미 다른 프로세스/);
    assert.equal((await devServers.start("s1", { name: "../x", command: "sleep 1", cwd: dir })).ok, false, "names cannot become paths");
  } finally {
    busy.close();
    devServers.stopAll("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing a session stops its dev servers", async () => {
  const { dir, devServers } = await manager();
  try {
    const started = await devServers.start("s1", { name: "watch", command: "sleep 30", cwd: dir });
    assert.equal(started.ok, true);
    const pid = started.ok ? started.server.pid : 0;
    devServers.stopSession("s1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    devServers.stopAll("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("ao-serve arguments: start with port and a command after --, list, logs, stop", () => {
  assert.deepEqual(parseServeArgv(["start", "web", "--port", "5173", "--", "npx", "pnpm@10.19.0", "dev:web"]), { op: "start", body: { name: "web", port: 5173, command: "npx pnpm@10.19.0 dev:web" } });
  assert.deepEqual(parseServeArgv(["start", "s", "--restart", "--", "python3", "-m", "http.server", "8765", "--directory", "my dir"]).body, { name: "s", restart: true, command: "python3 -m http.server 8765 --directory 'my dir'" });
  assert.deepEqual(parseServeArgv(["start", "one", "--", "pnpm dev && echo ok"]).body.command, "pnpm dev && echo ok");
  assert.equal(parseServeArgv(["start", "web"]).error, "실행할 명령이 필요합니다 (-- 뒤에)");
  assert.deepEqual(parseServeArgv(["logs", "web", "--lines", "20"]), { op: "logs", body: { name: "web", lines: 20 } });
  assert.deepEqual(parseServeArgv(["list"]), { op: "list", body: {} });
  assert.equal(parseServeArgv(["stop"]).error, "서버 이름이 필요합니다");
});

test("the generated ao-serve script starts and lists a server through the app with the run token", async () => {
  const { dir, devServers } = await manager();
  const app = express();
  app.use(express.json());
  registerServeRoutes(app, devServers);
  const http = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const appPort = (http.address() as { port: number }).port;
  const port = await freePort();
  const script = join(dir, "ao-serve");
  await writeFile(script, SERVE_CLI_SOURCE);
  await chmod(script, 0o755);
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "personal", agent: "claude" });
  const run = (args: string[], env: Record<string, string> = { SINAWI_COMPUTER_TOKEN: token }) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, SINAWI_PORT: String(appPort), ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
  try {
    const started = await run(["start", "web", "--port", String(port), "--", "python3", "-m", "http.server", String(port), "--bind", "127.0.0.1"]);
    assert.equal(started.code, 0, started.out);
    assert.match(started.out, /"ready": true/);
    assert.equal(await portOpen(port), true);
    const listed = await run(["list"]);
    assert.match(listed.out, /"name": "web"/);
    assert.equal(JSON.parse(listed.out)[0].cwd, await realpath(dir), "the server runs in the caller's folder");
    const noToken = await run(["list"], { SINAWI_COMPUTER_TOKEN: "" });
    assert.notEqual(noToken.code, 0);
    assert.match(noToken.out, /세션 안에서만/);
  } finally {
    http.close();
    devServers.stopAll("SIGKILL");
    clearComputerTokens();
    await rm(dir, { recursive: true, force: true });
  }
});
