// H1: the app window's key. No HTTP route hands it out, whoever asks and whatever its process looks
// like; the installed app's binary gets it over a unix socket after checking the peer with the kernel
// (that check itself is tested in src-tauri/src/peer_check.rs); dev runs hand it over a pipe.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { appBinaryPeerCheck, appKey, appKeySocketPath, hasAppKey, initAppKey, serveAppKey } from "./app-key.js";
import { createServer } from "./server.js";

const run = promisify(execFile);
const APP_EXE = "/Applications/Sinawi.app/Contents/MacOS/sinawi";

async function folder(t: test.TestContext, name: string) {
  // Short: a unix socket path must stay under 104 bytes.
  const dir = await mkdtemp(join("/tmp", `sk-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

/** What a client reads from the key socket before it closes. */
function readSocket(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

test("the dev key comes over an inherited pipe, and the environment keeps neither it nor the app path", () => {
  const env: NodeJS.ProcessEnv = { SINAWI_APP_KEY_FD: "3", SINAWI_APP_EXE: APP_EXE, PATH: "/bin" };
  initAppKey(env, () => `${"k".repeat(43)}\n`);
  assert.equal(appKey(), "k".repeat(43));
  assert.deepEqual(Object.keys(env), ["PATH"]);
  initAppKey({ SINAWI_APP_KEY_FD: "3" }, () => "short");
  assert.notEqual(appKey(), "short", "a weak key is replaced by a random one");
  assert.ok(appKey().length >= 32);
  initAppKey({ SINAWI_APP_KEY: "k".repeat(43) } as NodeJS.ProcessEnv);
  assert.notEqual(appKey(), "k".repeat(43), "a key in the environment (visible to ps -E) is not taken");
});

test("a server started the way dev.mjs starts it has the key, and ps -E does not show it", { skip: process.platform !== "darwin" }, async () => {
  const secret = "d".repeat(43);
  // The script compares hashes, so the key itself is in neither its arguments nor its environment.
  const hash = createHash("sha256").update(secret).digest("hex");
  const script = `import { createHash } from "node:crypto"; import { initAppKey, appKey } from "./server/app-key.ts"; initAppKey(); process.stdout.write(createHash("sha256").update(appKey()).digest("hex") === "${hash}" ? "same" : "different"); setTimeout(() => undefined, 1500);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit", "pipe"], env: { ...process.env, SINAWI_APP_KEY_FD: "3" } });
  (child.stdio[3] as NodeJS.WritableStream).end(`${secret}\n`);
  let out = "";
  child.stdout!.on("data", (chunk) => { out += chunk; });
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  const { stdout: environment } = await run("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(child.pid)]);
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(out, "same");
  assert.ok(!environment.includes(secret), "the key is not in the process environment");
});

test("a request carries the key in the header or as a sinawi-app.<key> subprotocol", () => {
  initAppKey({});
  const key = appKey();
  assert.ok(hasAppKey({ "x-sinawi-app": key }));
  assert.ok(!hasAppKey({ "x-sinawi-app": `${key}x` }));
  assert.ok(!hasAppKey({ origin: "http://127.0.0.1:3001" }));
  assert.ok(hasAppKey({ "sec-websocket-protocol": `other, sinawi-app.${key}` }));
  assert.ok(!hasAppKey({ "sec-websocket-protocol": "sinawi-app.nope" }));
});

// The independent review's attack, as it was run: argv[0] set to the app's path made the old
// `ps -o comm` check hand the key to curl. There is no such route any more, for any process.
test("curl posing as the app binary (exec -a) gets no key over HTTP", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = await folder(t, "http");
  initAppKey({ SINAWI_APP_EXE: APP_EXE });
  const created = createServer({ dataDir: dir, modelHomeDir: dir, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  await new Promise<void>((resolve) => created.httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); });
  const port = (created.httpServer.address() as { port: number }).port;
  const { stdout } = await run("/bin/bash", ["-c", `exec -a ${APP_EXE} /usr/bin/curl -s -w '\\n%{http_code}' http://127.0.0.1:${port}/api/app-key`]);
  assert.ok(!stdout.includes(appKey()), "no key in the answer");
  assert.equal(stdout.trim().split("\n").at(-1), "404");
});

test("the key socket answers only connections the peer check accepts, from a folder only this user can enter", async (t) => {
  const dir = await folder(t, "sock");
  initAppKey({});
  const path = appKeySocketPath(dir);
  let verdict = false;
  const stop = await serveAppKey(path, async () => verdict);
  t.after(stop);
  assert.equal((await stat(join(dir, "run"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readSocket(path), "", "refused: closed with nothing sent");
  verdict = true;
  assert.equal(await readSocket(path), `${appKey()}\n`);
  await stop();
  await assert.rejects(stat(path), "stopping removes the socket");
});

test("the app binary checks the connection itself: it runs with the connection as fd 3, and only exit 0 lets the key go", async (t) => {
  const dir = await folder(t, "check");
  initAppKey({});
  // Stands in for `sinawi --sinawi-check-peer`: proves it holds the connection by writing to fd 3.
  const checker = join(dir, "checker");
  await writeFile(checker, `#!/bin/sh\n[ "$1" = "--sinawi-check-peer" ] || exit 9\nprintf 'checked:' >&3\nexit "$(cat ${join(dir, "verdict")})"\n`);
  await chmod(checker, 0o755);
  const path = appKeySocketPath(dir);
  t.after(await serveAppKey(path, appBinaryPeerCheck(checker)));
  await writeFile(join(dir, "verdict"), "1");
  assert.equal(await readSocket(path), "checked:", "the checker said no: no key");
  await writeFile(join(dir, "verdict"), "0");
  assert.equal(await readSocket(path), `checked:${appKey()}\n`);
  t.after(await serveAppKey(join(dir, "run", "missing.sock"), appBinaryPeerCheck(join(dir, "no-such-binary"))));
  assert.equal(await readSocket(join(dir, "run", "missing.sock")), "", "a checker that cannot start says no");
});
