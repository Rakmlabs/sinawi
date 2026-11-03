import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rename, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { BrowserBridge, CLI_SOURCE, SKILL_MD, installBrowserTooling, isBrowserAction, isOwnAppUrl, materialize, prepareBrowserArgs, registerBrowserRoutes, watchQueue, type BrowserCommand } from "./browser-bridge.js";
import { buildInvocation } from "./cli.js";
import { clearComputerTokens, issueComputerToken } from "./computer-tokens.js";

test("bridge resolves a command with the frontend result", async () => {
  const sent: BrowserCommand[] = [];
  const bridge = new BrowserBridge((c) => { sent.push(c); return 1; });
  const p = bridge.request("snapshot", {});
  assert.equal(sent[0].action, "snapshot");
  assert.ok(bridge.resolve(sent[0].id, { ok: true, result: { snapshot: "x" } }));
  assert.deepEqual(await p, { ok: true, result: { snapshot: "x" }, error: undefined });
  assert.equal(bridge.size, 0);
});

test("bridge fails fast without an app window and times out otherwise", async () => {
  assert.match((await new BrowserBridge(() => 0).request("click", {})).error!, /앱 창이 열려 있지 않습니다/);
  const r = await new BrowserBridge(() => 1).request("click", {}, 30);
  assert.equal(r.ok, false); assert.match(r.error!, /응답하지 않았습니다/);
});

test("goto to the app port fails without waiting for WebContent", async () => {
  let sent = 0;
  const r = await new BrowserBridge(() => { sent++; return 1; }).request("goto", { url: "http://localhost:3001" }, 30_000);
  assert.equal(r.ok, false);
  assert.match(r.error!, /자체 주소/);
  assert.equal(sent, 0);
  assert.equal(isOwnAppUrl("3001"), true);
  assert.equal(isOwnAppUrl("http://127.0.0.1:3001/"), true);
  assert.equal(isOwnAppUrl("5173"), false);
});

test("a new tab aimed at the app port fails without waiting for WebContent", async () => {
  let sent = 0;
  const r = await new BrowserBridge(() => { sent++; return 1; }).request("tab", { op: "new", url: "http://127.0.0.1:3001/" }, 30_000);
  assert.equal(r.ok, false);
  assert.match(r.error!, /자체 주소/);
  assert.equal(sent, 0);
});

test("click is delivered once while the window stays silent", async () => {
  let n = 0;
  const bridge = new BrowserBridge(() => { n++; return 1; });
  const pending = bridge.request("click", { ref: "e1" }, 1200);
  await new Promise((r) => setTimeout(r, 850));
  assert.equal(n, 1);
  assert.equal((await pending).ok, false);
});

test("bridge resends a command while the window is silent", async () => {
  let n = 0;
  let sent: BrowserCommand | undefined;
  const bridge = new BrowserBridge((c) => { sent = c; n++; return 1; });
  const p = bridge.request("status", {}, 1200);
  await new Promise((r) => setTimeout(r, 850));
  assert.ok(n >= 2);
  assert.ok(bridge.resolve(sent!.id, { ok: true, result: { ready: true } }));
  assert.equal((await p).ok, true);
});

test("action whitelist", () => {
  assert.ok(isBrowserAction("goto")); assert.ok(isBrowserAction("screenshot"));
  assert.ok(isBrowserAction("viewport")); assert.ok(isBrowserAction("upload")); assert.ok(isBrowserAction("dialog"));
  assert.ok(isBrowserAction("network")); assert.ok(isBrowserAction("tab")); assert.ok(isBrowserAction("keyboard"));
  assert.ok(!isBrowserAction("eval")); assert.ok(!isBrowserAction("result"));
});

test("upload reads a local file and rejects a missing path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobu-"));
  const file = join(dir, "note.txt");
  await writeFile(file, "hello");
  const ready = await prepareBrowserArgs("upload", { ref: "e3", path: file });
  const body = ready.file as { name: string; type: string; base64: string };
  assert.equal(body.name, "note.txt");
  assert.equal(body.type, "text/plain");
  assert.equal(Buffer.from(body.base64, "base64").toString("utf8"), "hello");
  assert.deepEqual(await prepareBrowserArgs("click", { ref: "e1" }), { ref: "e1" });
  await assert.rejects(prepareBrowserArgs("upload", { ref: "e3", path: join(dir, "missing.png") }), /파일을 찾을 수 없습니다/);
  await assert.rejects(prepareBrowserArgs("upload", { ref: "e3" }), /파일 경로가 필요합니다/);
});

test("screenshots become png files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aob-"));
  const png = "data:image/png;base64," + Buffer.from("PNGDATA").toString("base64");
  const out = await materialize({ ok: true, result: { image: png, url: "u" } }, dir);
  const path = (out.result as { path: string }).path;
  assert.equal(await readFile(path, "utf8"), "PNGDATA");
  assert.equal((out.result as { image?: string }).image, undefined);
});

test("http routes relay to the frontend and reject unknown actions", async () => {
  const app = express(); app.use(express.json());
  let bridge!: BrowserBridge;
  bridge = new BrowserBridge((c) => { setTimeout(() => bridge.resolve(c.id, { ok: true, result: { echo: c.args } }), 5); return 1; });
  registerBrowserRoutes(app, bridge);
  const server = app.listen(0); const port = (server.address() as { port: number }).port;
  try {
    const ok = await (await fetch(`http://127.0.0.1:${port}/api/browser/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: "e1" }) })).json();
    assert.deepEqual(ok.result, { echo: { ref: "e1" } });
    const bad = await fetch(`http://127.0.0.1:${port}/api/browser/eval`, { method: "POST" });
    assert.equal(bad.status, 404);
  } finally { server.close(); }
});

test("file queue fallback answers requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobq-"));
  let bridge!: BrowserBridge;
  bridge = new BrowserBridge((c) => { setTimeout(() => bridge.resolve(c.id, { ok: true, result: { action: c.action } }), 5); return 1; });
  const stop = watchQueue(bridge, dir, 20);
  try {
    await writeFile(join(dir, "a.req.tmp"), JSON.stringify({ action: "status", args: {} }));
    await rename(join(dir, "a.req.tmp"), join(dir, "a.req.json"));
    let res: string | undefined;
    for (let i = 0; i < 100 && !res; i++) { await new Promise((r) => setTimeout(r, 20)); if ((await readdir(dir)).includes("a.res.json")) res = await readFile(join(dir, "a.res.json"), "utf8"); }
    assert.deepEqual(JSON.parse(res!), { ok: true, result: { action: "status" } });
  } finally { stop(); }
});

test("file queue survives its directory vanishing before the response is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobq-gone-"));
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  let answered!: () => void;
  const done = new Promise<void>((resolve) => { answered = resolve; });
  let bridge!: BrowserBridge;
  let stop = () => undefined as void;
  bridge = new BrowserBridge((c) => {
    stop();
    void rm(dir, { recursive: true, force: true }).then(() => { bridge.resolve(c.id, { ok: true, result: {} }); answered(); });
    return 1;
  });
  stop = watchQueue(bridge, dir, 10);
  try {
    await writeFile(join(dir, "b.req.tmp"), JSON.stringify({ action: "status", args: {} }));
    await rename(join(dir, "b.req.tmp"), join(dir, "b.req.json"));
    await done;
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(rejections, []);
  } finally { stop(); process.off("unhandledRejection", onRejection); }
});

test("CLI prints usage and parses refs vs selectors via the http route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobc-"));
  for (const a of [".codex", ".claude", ".grok"]) await mkdir(join(dir, a), { recursive: true });
  await installBrowserTooling(dir);
  const cli = join(dir, ".local", "bin", "ao-browser");
  assert.equal(await readFile(cli, "utf8"), CLI_SOURCE);
  for (const a of [".codex", ".claude", ".grok"]) assert.equal(await readFile(join(dir, a, "skills", "orchestra-browser", "SKILL.md"), "utf8"), SKILL_MD);
  const run = promisify(execFile);
  assert.match((await run("node", [cli])).stdout, /사용법/);
  const app = express(); app.use(express.json());
  const seen: BrowserCommand[] = [];
  let bridge!: BrowserBridge;
  bridge = new BrowserBridge((c) => { seen.push(c); setTimeout(() => bridge.resolve(c.id, c.action === "snapshot" ? { ok: true, result: { snapshot: "[e1] button \"저장\"" } } : { ok: false, error: "없음" }), 5); return 1; });
  registerBrowserRoutes(app, bridge);
  const server = app.listen(0); const port = (server.address() as { port: number }).port;
  try {
    const env = { ...process.env, SINAWI_PORT: String(port) };
    assert.match((await run("node", [cli, "snapshot"], { env })).stdout, /\[e1\] button "저장"/);
    await assert.rejects(run("node", [cli, "click", "e7"], { env }), /오류: 없음/);
    await assert.rejects(run("node", [cli, "fill", "#name", "홍", "길동"], { env }));
    assert.deepEqual(seen[1].args, { ref: "e7" });
    assert.deepEqual(seen[2].args, { selector: "#name", text: "홍 길동" });
  } finally { server.close(); }
  await mkdir(dir, { recursive: true });
});

test("CLI parses viewport, dialog, upload, tabs, and keyboard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobv-"));
  await installBrowserTooling(dir);
  const cli = join(dir, ".local", "bin", "ao-browser");
  const run = promisify(execFile);
  await assert.rejects(run("node", [cli, "--help"], { encoding: "utf8" }), (error: NodeJS.ErrnoException & { stdout?: string; code?: number }) => {
    assert.equal(error.code, 2);
    assert.match(error.stdout ?? "", /viewport <iphone\|tablet\|desktop\|WxH>/);
    assert.match(error.stdout ?? "", /dialog \[accept\|dismiss\]/);
    return true;
  });
  const app = express(); app.use(express.json({ limit: "2mb" }));
  const seen: BrowserCommand[] = [];
  let bridge!: BrowserBridge;
  bridge = new BrowserBridge((c) => { seen.push(c); setTimeout(() => bridge.resolve(c.id, { ok: true, result: c.action === "click" ? { clicked: "e1", snapshot: "[e1] button \"저장\"" } : { echo: c.action } }), 5); return 1; });
  registerBrowserRoutes(app, bridge);
  const server = app.listen(0); const port = (server.address() as { port: number }).port;
  const env = { ...process.env, SINAWI_PORT: String(port) };
  const exec = (args: string[]) => run("node", [cli, ...args], { env, encoding: "utf8" });
  try {
    assert.match((await exec(["click", "e1"])).stdout, /클릭 e1/);
    assert.match((await exec(["click", "e1"])).stdout, /\[e1\] button "저장"/);
    await exec(["viewport", "iphone"]);
    await exec(["viewport", "390x844"]);
    await exec(["dialog", "dismiss"]);
    await exec(["keyboard", "Control+A"]);
    await exec(["tab", "select", "2"]);
    await exec(["scroll", "e7", "down", "120"]);
    await exec(["wait", "idle"]);
    const file = join(dir, "pic.png");
    await writeFile(file, "PNG");
    await exec(["upload", "e4", file]);
    assert.deepEqual(seen.map((c) => c.action), ["click", "click", "viewport", "viewport", "dialog", "keyboard", "tab", "scroll", "wait", "upload"]);
    assert.deepEqual(seen[2].args, { preset: "iphone" });
    assert.deepEqual(seen[3].args, { preset: "390x844" });
    assert.deepEqual(seen[4].args, { accept: false });
    assert.deepEqual(seen[5].args, { key: "Control+A" });
    assert.deepEqual(seen[6].args, { op: "select", index: 2 });
    assert.deepEqual(seen[7].args, { ref: "e7", direction: "down", amount: 120 });
    assert.deepEqual(seen[8].args, { idle: true });
    const uploaded = seen[9].args as { ref: string; path: string; file: { name: string; base64: string } };
    assert.equal(uploaded.ref, "e4");
    assert.equal(uploaded.file.name, "pic.png");
    assert.equal(Buffer.from(uploaded.file.base64, "base64").toString("utf8"), "PNG");
  } finally { server.close(); }
});

test("agents may run ao-browser", () => {
  const claude = buildInvocation({ agent: "claude", prompt: "p", cwd: "/tmp" }).args;
  assert.ok(claude.includes("Bash(ao-browser:*)"));
  const grok = buildInvocation({ agent: "grok", prompt: "p", cwd: "/tmp" }).args;
  assert.ok(grok.includes("Bash(ao-browser:*)"));
});


test("skill folders are created only for CLIs that are installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aobs-"));
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await installBrowserTooling(dir);
    assert.equal(await readFile(join(dir, ".claude", "skills", "orchestra-browser", "SKILL.md"), "utf8"), SKILL_MD);
    await assert.rejects(stat(join(dir, ".codex")));
    await assert.rejects(stat(join(dir, ".grok")));
    // A binary on PATH counts too.
    const bin = join(dir, "pathbin");
    await mkdir(bin);
    await writeFile(join(bin, "grok"), "");
    process.env.PATH = bin;
    await installBrowserTooling(dir);
    assert.equal(await readFile(join(dir, ".grok", "skills", "orchestra-browser", "SKILL.md"), "utf8"), SKILL_MD);
    await assert.rejects(stat(join(dir, ".codex")));
  } finally { process.env.PATH = savedPath; }
});

test("a command from an agent run carries that run's workspace", async () => {
  const sent: BrowserCommand[] = [];
  const bridge = new BrowserBridge((c) => { sent.push(c); return 1; });
  const p = bridge.request("snapshot", {}, undefined, "company", "s1:orchestrator");
  assert.equal(sent[0].workspaceId, "company");
  assert.equal(sent[0].owner, "s1:orchestrator");
  bridge.resolve(sent[0].id, { ok: true });
  await p;
  const q = bridge.request("snapshot", {});
  assert.equal("workspaceId" in sent[1], false);
  assert.equal("owner" in sent[1], false);
  bridge.resolve(sent[1].id, { ok: true });
  await q;
});

test("the app server refuses a browser command without a live run token", async () => {
  clearComputerTokens();
  const app = express(); app.use(express.json());
  const seen: BrowserCommand[] = [];
  let bridge!: BrowserBridge;
  bridge = new BrowserBridge((c) => { seen.push(c); setTimeout(() => bridge.resolve(c.id, { ok: true }), 5); return 1; });
  registerBrowserRoutes(app, bridge, true);
  const server = app.listen(0); const port = (server.address() as { port: number }).port;
  const call = (token?: string) => fetch(`http://127.0.0.1:${port}/api/browser/snapshot`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-sinawi-token": token } : {}) }, body: "{}" });
  try {
    const bare = await call();
    assert.equal(bare.status, 403);
    assert.match((await bare.json()).error, /SINAWI_COMPUTER_TOKEN을 지우거나/);
    assert.equal(seen.length, 0, "nothing reaches the screen");
    const token = issueComputerToken({ sessionId: "s1", workspaceId: "personal", agent: "claude", owner: "s1:claude-1" });
    assert.equal((await call(token)).status, 200);
    assert.equal(seen[0].workspaceId, "personal");
    assert.equal(seen[0].owner, "s1:claude-1");
  } finally { server.close(); clearComputerTokens(); }
});
