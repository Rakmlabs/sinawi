// H1: the app window's key comes from the environment once and leaves it; a request proves itself
// with the header or the WebSocket subprotocol; only the app binary itself collects it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { appKey, hasAppKey, initAppKey, isAppExecutable, peerExecutable } from "./app-key.js";

test("the key leaves the environment, so the CLIs the server runs do not inherit it", () => {
  const env: NodeJS.ProcessEnv = { SINAWI_APP_KEY: "k".repeat(43), SINAWI_APP_EXE: "/Applications/Sinawi.app/Contents/MacOS/sinawi", PATH: "/bin" };
  initAppKey(env);
  assert.equal(appKey(), "k".repeat(43));
  assert.deepEqual(Object.keys(env), ["PATH"]);
  assert.ok(isAppExecutable("/Applications/Sinawi.app/Contents/MacOS/sinawi"));
  assert.ok(!isAppExecutable("/usr/bin/curl"));
  assert.ok(!isAppExecutable(undefined));
  initAppKey({ SINAWI_APP_KEY: "short" });
  assert.notEqual(appKey(), "short", "a weak key is replaced by a random one");
  assert.ok(appKey().length >= 32);
  assert.ok(!isAppExecutable("/anything"), "without SINAWI_APP_EXE nobody collects the key");
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

test("the server sees which program is on the other end of a loopback connection", { skip: process.platform !== "darwin" }, async (t) => {
  let seen: string | undefined;
  const server = createServer(async (req, res) => { seen = await peerExecutable(req.socket.remotePort); res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  // Another process (not this server) makes the request: its executable is what comes back.
  const child = spawn("/usr/bin/curl", ["-s", `http://127.0.0.1:${port}/`]);
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(seen, "/usr/bin/curl");
  assert.ok(!isAppExecutable(seen, process.execPath));
});
