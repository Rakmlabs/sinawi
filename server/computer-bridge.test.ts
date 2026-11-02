import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { APPROVAL_TIMEOUT_MESSAGE, CLI_SOURCE, ComputerBridge, DENIED_MESSAGE, NATIVE_APPROVAL_TIMEOUT, NATIVE_DENIED, SKILL_MD, STOPPED_MESSAGE, TOKEN_MESSAGE, describeAction, ensurePrivateDir, installComputerTooling, parseComputerArgv, pixelsToPoints, registerComputerRoutes, validateComputerArgs, watchComputerQueue, type ComputerBridgeOptions, type ComputerCommand, type ComputerContext } from "./computer-bridge.js";
import { clearComputerTokens, computerContextForToken, computerRunEnv, issueComputerToken, pruneComputerTokens, resolveComputerDir, resolveComputerToken } from "./computer-tokens.js";
import { computerUseBlockedMessage } from "./workspace-policy.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
type Sent = ComputerCommand & { nonce: string };

/** Tokens "t1", "t2", "t3" belong to sessions s1, s2, s3; anything else is refused. */
const tokenContext = (workspaces: Record<string, string> = {}) => (hint: { token?: string }): ComputerContext | undefined => {
  const match = /^t(\d)$/.exec(hint.token ?? "");
  if (!match) return undefined;
  const s = `s${match[1]}`;
  return { key: `session:${s}`, sessionId: s, workspaceId: workspaces[s] ?? "default", agent: "claude", title: "t", workspaceName: "기본" };
};

async function harness(overrides: Partial<ComputerBridgeOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cu-test-"));
  const sent: Sent[] = [];
  const messages: Record<string, any>[] = [];
  let allowed = true;
  const bridge = new ComputerBridge({
    send: (c, nonce) => { sent.push({ ...c, nonce: nonce() }); return 1; },
    broadcast: (m) => { messages.push(m); },
    windows: () => 1,
    isAllowed: () => allowed,
    resolveContext: tokenContext(),
    logFile: join(dir, "computer.log"),
    shotDir: join(dir, "shots"),
    ...overrides,
  });
  let replied = 0;
  /** Answers the next command that has not been answered yet (or `index`), as the app window would. */
  const reply = async (result: { ok: boolean; result?: unknown; error?: string; grant?: "once" | "session" }, index?: number) => {
    const at = index ?? replied;
    for (let i = 0; i < 200 && !sent[at]; i++) await tick();
    assert.ok(sent[at], `command ${at} was never sent`);
    assert.ok(bridge.resolve(sent[at].id, sent[at].nonce, result));
    replied = Math.max(replied, at + 1);
  };
  return { bridge, sent, messages, reply, dir, setAllowed: (v: boolean) => { allowed = v; } };
}
const T1 = { token: "t1" };

test("argv parsing covers every action and flag", () => {
  assert.deepEqual(parseComputerArgv(["screenshot", "--display", "1", "--max", "1280"]), { action: "screenshot", args: { display: 1, max: 1280 } });
  assert.deepEqual(parseComputerArgv(["shot", "--region", "10,20,300,200"]).args, { region: { x: 10, y: 20, w: 300, h: 200 } });
  assert.deepEqual(parseComputerArgv(["screenshot", "--app=TextEdit", "--retina"]).args, { app: "TextEdit", retina: true });
  assert.deepEqual(parseComputerArgv(["click", "100", "200.5", "--pixels"]), { action: "click", args: { x: 100, y: 200.5, space: "pixels" } });
  assert.deepEqual(parseComputerArgv(["double-click", "1", "2", "--self"]), { action: "double_click", args: { x: 1, y: 2, allowSelf: true } });
  assert.deepEqual(parseComputerArgv(["drag", "1", "2", "3", "4"]).args, { x: 1, y: 2, x2: 3, y2: 4 });
  assert.deepEqual(parseComputerArgv(["type", "안녕", "하세요"]).args, { text: "안녕 하세요" });
  assert.deepEqual(parseComputerArgv(["type", "--", "--literal"]).args, { text: "--literal" });
  assert.deepEqual(parseComputerArgv(["key", "cmd+shift+t", "--repeat", "2"]).args, { key: "cmd+shift+t", repeat: 2 });
  assert.deepEqual(parseComputerArgv(["scroll", "down", "400", "--at", "10", "20"]).args, { direction: "down", amount: 400, x: 10, y: 20 });
  assert.deepEqual(parseComputerArgv(["ax", "TextEdit", "--depth", "8"]).args, { app: "TextEdit", depth: 8 });
  assert.deepEqual(parseComputerArgv(["ax_set_value", "a7", "hello", "world"]).args, { ref: "a7", text: "hello world" });
  assert.deepEqual(parseComputerArgv(["activate", "Visual", "Studio", "Code"]).args, { app: "Visual Studio Code" });
  assert.deepEqual(parseComputerArgv(["wait", "250"]).args, { ms: 250 });
  assert.equal(parseComputerArgv(["status"]).action, "status");
  assert.match(parseComputerArgv(["explode"]).error!, /알 수 없는 명령/);
});

test("validation rejects bad input with actionable errors", () => {
  assert.throws(() => validateComputerArgs("click", { x: "abc", y: 1 }), /x 값이 필요합니다/);
  assert.throws(() => validateComputerArgs("type", { text: "" }), /입력할 글자/);
  assert.throws(() => validateComputerArgs("type", { text: "x".repeat(5001) }), /5000자/);
  assert.throws(() => validateComputerArgs("key", { key: "" }), /키 조합/);
  assert.throws(() => validateComputerArgs("scroll", { direction: "sideways" }), /방향/);
  assert.throws(() => validateComputerArgs("ax_click", { ref: "e12" }), /ax ref/);
  assert.throws(() => validateComputerArgs("screenshot", { display: 0, window: 3 }), /하나만/);
  assert.throws(() => validateComputerArgs("wait", { ms: 99_999 }), /범위/);
  assert.deepEqual(validateComputerArgs("click", { x: "10", y: 20, allowSelf: true, junk: 1 }), { x: 10, y: 20, allowSelf: true });
  assert.equal(describeAction("type", { text: "비밀 내용" }), "글자 입력 (5자)", "typed text never reaches logs");
});

test("screenshot pixels map to points on Retina and offset displays", () => {
  assert.deepEqual(pixelsToPoints({ rect: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2 }, 1000, 500), { x: 500, y: 250 });
  assert.deepEqual(pixelsToPoints({ rect: { x: -1920, y: -200, w: 1920, h: 1080 }, scale: 1 }, 10, 10), { x: -1910, y: -190 });
  assert.deepEqual(pixelsToPoints({ rect: { x: 100, y: 50, w: 800, h: 600 }, scale: 0.5 }, 100, 100), { x: 300, y: 250 }, "downscaled shots scale up");
});

test("workspace policy gate refuses before reaching the app", async () => {
  const h = await harness();
  h.setAllowed(false);
  const r = await h.bridge.request("click", { x: 1, y: 2 }, T1);
  assert.equal(r.ok, false);
  assert.equal(r.error, computerUseBlockedMessage);
  assert.equal(h.sent.length, 0);
  await h.bridge.flushLog();
  assert.match(await readFile(join(h.dir, "computer.log"), "utf8"), /blocked by workspace setting/);
  h.bridge.dispose();
});

test("requests without a valid run token are refused, whatever session they claim", async () => {
  const h = await harness();
  assert.equal((await h.bridge.request("click", { x: 1, y: 2 })).error, TOKEN_MESSAGE);
  assert.equal((await h.bridge.request("click", { x: 1, y: 2 }, { token: "forged" })).error, TOKEN_MESSAGE);
  assert.equal((await h.bridge.request("status", {}, {})).error, TOKEN_MESSAGE);
  assert.equal(h.sent.length, 0, "nothing reaches the app");
  h.bridge.dispose();
});

test("commands carry the dialog context; the native grant is mirrored for display only", async () => {
  const h = await harness();
  const first = h.bridge.request("click", { x: 5, y: 6 }, T1);
  for (let i = 0; i < 100 && !h.sent.length; i++) await tick();
  assert.deepEqual(h.sent[0].context, { agent: "claude", workspace: "기본", title: "t", summary: "클릭 (5, 6)" });
  assert.equal(h.sent[0].key, "session:s1");
  await h.reply({ ok: true, result: { x: 5, y: 6 }, grant: "session" });
  assert.equal((await first).ok, true);
  assert.equal(h.bridge.state().active, true);
  assert.equal("pending" in h.bridge.state(), false, "the server keeps no approval dialog");

  const once = h.bridge.request("cursor", {}, { token: "t2" });
  await h.reply({ ok: true, result: {}, grant: "once" }, 1);
  assert.equal((await once).ok, true);
  assert.deepEqual(h.bridge.state().sessions.map((s) => s.key), ["session:s1"], "allow-once is not shown as a session approval");
  h.bridge.dispose();
});

test("a native denial is reported, sticks for a while and drops the display entry", async () => {
  const h = await harness();
  const p = h.bridge.request("cursor", {}, T1);
  await h.reply({ ok: false, error: `${NATIVE_DENIED}사용자가 거부` });
  assert.equal((await p).error, DENIED_MESSAGE);
  assert.equal((await h.bridge.request("cursor", {}, T1)).error, DENIED_MESSAGE, "a denial sticks for a while");
  assert.equal(h.sent.length, 1);
  const late = h.bridge.request("cursor", {}, { token: "t2" });
  await h.reply({ ok: false, error: `${NATIVE_APPROVAL_TIMEOUT}no answer` }, 1);
  assert.equal((await late).error, APPROVAL_TIMEOUT_MESSAGE);
  h.bridge.dispose();
});

test("results are accepted only for dispatched, unanswered commands with their nonce", async () => {
  const h = await harness();
  const p = h.bridge.request("cursor", {}, T1);
  for (let i = 0; i < 100 && !h.sent.length; i++) await tick();
  const { id, nonce } = h.sent[0];
  assert.equal(h.bridge.resolve("not-dispatched", nonce, { ok: true }), false, "unknown id");
  assert.equal(h.bridge.resolve(id, "", { ok: true }), false, "no nonce");
  assert.equal(h.bridge.resolve(id, "guess", { ok: true }), false, "wrong nonce");
  assert.equal(h.bridge.resolve(id, nonce, { ok: true, result: { x: 1 } }), true);
  assert.equal(h.bridge.resolve(id, nonce, { ok: true, result: { x: 2 } }), false, "answered once only");
  assert.deepEqual((await p).result, { x: 1 });

  // Each connection gets its own nonce.
  const nonces: string[] = [];
  const two = await harness({ send: (c, nonce) => { nonces.push(nonce(), nonce()); two.sent.push({ ...c, nonce: nonces[0] }); return 2; } });
  const q = two.bridge.request("cursor", {}, T1);
  for (let i = 0; i < 100 && !two.sent.length; i++) await tick();
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(two.bridge.resolve(two.sent[0].id, nonces[1], { ok: true, result: 2 }), true, "either window's nonce answers");
  assert.equal((await q).result, 2);
  two.bridge.dispose();
  h.bridge.dispose();
});

test("the result route refuses forged answers", async () => {
  const h = await harness();
  const app = express();
  app.use(express.json());
  registerComputerRoutes(app, h.bridge, join(h.dir, "shots"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/computer/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const p = h.bridge.request("cursor", {}, T1);
    for (let i = 0; i < 100 && !h.sent.length; i++) await tick();
    assert.equal((await post({ id: h.sent[0].id, ok: true, result: "forged" })).status, 409);
    assert.equal((await post({ id: h.sent[0].id, nonce: "x", ok: true })).status, 409);
    assert.equal((await post({ id: h.sent[0].id, nonce: h.sent[0].nonce, ok: true, result: "real" })).status, 200);
    assert.equal((await p).result, "real");
    const approval = await fetch(`http://127.0.0.1:${port}/api/computer/approval`, { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" }, body: JSON.stringify({ id: "x", decision: "session" }) });
    assert.match((await approval.json()).error, /알 수 없는 컴퓨터 명령: approval/, "there is no server approval route");
  } finally {
    server.close();
    h.bridge.dispose();
  }
});

test("commands run one at a time; unapproved sessions get time for the native alert", async () => {
  const h = await harness({ approvalTimeoutMs: 1_000, timeoutMs: 30 });
  const slow = h.bridge.request("click", { x: 1, y: 1 }, T1);
  for (let i = 0; i < 100 && !h.sent.length; i++) await tick();
  // 30ms action timeout + alert allowance: still pending well after 30ms.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.bridge.size, 1, "the alert allowance applies before a session approval");
  await h.reply({ ok: true, result: {}, grant: "session" });
  assert.equal((await slow).ok, true);
  const fast = await h.bridge.request("click", { x: 1, y: 1 }, T1);
  assert.match(fast.error!, /응답하지 않았습니다/, "approved sessions use the plain timeout");
  assert.equal(h.bridge.state().active, false, "a timed-out session falls back to the long timeout");

  const q = await harness();
  const a = q.bridge.request("move", { x: 1, y: 1 }, T1);
  const b = q.bridge.request("move", { x: 2, y: 2 }, T1);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(q.sent.length, 1, "second command waits for the first");
  await q.reply({ ok: true, result: {} }, 0);
  await q.reply({ ok: true, result: {} }, 1);
  assert.equal((await a).ok && (await b).ok, true);
  assert.equal((await q.bridge.request("wait", { ms: 1 }, T1)).ok, true, "wait runs on the server");
  q.bridge.dispose();
  h.bridge.dispose();
});

test("a missing window is reported", async () => {
  const none = await harness({ send: () => 0 });
  assert.match((await none.bridge.request("click", { x: 1, y: 1 }, T1)).error!, /앱 창이 열려 있지 않습니다/);
  none.bridge.dispose();
});

test("global stop rejects queued commands, revokes approvals and blocks for a cooldown", async () => {
  const h = await harness();
  const first = h.bridge.request("move", { x: 1, y: 1 }, T1);
  await h.reply({ ok: true, result: {}, grant: "session" });
  await first;
  const a = h.bridge.request("move", { x: 1, y: 1 }, T1);
  const b = h.bridge.request("move", { x: 2, y: 2 }, T1);
  const c = h.bridge.request("wait", { ms: 5_000 }, T1);
  for (let i = 0; i < 100 && h.sent.length < 2; i++) await tick();
  h.bridge.stop("hotkey");
  assert.deepEqual([(await a).error, (await b).error, (await c).error], [STOPPED_MESSAGE, STOPPED_MESSAGE, STOPPED_MESSAGE]);
  assert.equal(h.sent.length, 2, "queued commands never reach the app");
  assert.equal(h.bridge.state().active, false);
  assert.ok(h.messages.some((m) => m.type === "computer-revoked"));
  assert.equal((await h.bridge.request("cursor", {}, T1)).error, STOPPED_MESSAGE);
  h.bridge.dispose();
});

test("turning the workspace setting off revokes its sessions and in-flight commands", async () => {
  const allowed = new Set(["default", "other"]);
  const h = await harness({ isAllowed: (id) => allowed.has(id), resolveContext: tokenContext({ s3: "other" }) });
  const first = h.bridge.request("move", { x: 1, y: 1 }, T1);
  await h.reply({ ok: true, result: {}, grant: "session" });
  assert.equal((await first).ok, true);
  const other = h.bridge.request("move", { x: 1, y: 1 }, { token: "t3" });
  await h.reply({ ok: true, result: {}, grant: "session" });
  assert.equal((await other).ok, true);

  const inFlight = h.bridge.request("move", { x: 2, y: 2 }, T1);
  const queued = h.bridge.request("move", { x: 3, y: 3 }, T1);
  for (let i = 0; i < 100 && h.sent.length < 3; i++) await tick();
  allowed.delete("default");
  h.bridge.revokeWorkspace("default");
  assert.deepEqual([(await inFlight).error, (await queued).error], [computerUseBlockedMessage, computerUseBlockedMessage]);
  assert.equal(h.sent.length, 3, "the queued command never reaches the app");
  assert.deepEqual(h.messages.filter((m) => m.type === "computer-revoked").map((m) => m.key), ["session:s1"], "the app drops exactly this workspace's keys");
  assert.deepEqual(h.bridge.state().sessions.map((s) => s.key), ["session:s3"], "other workspaces keep their approval");
  h.bridge.dispose();
});

test("native refusals (secure field) pass through and are logged without the text", async () => {
  const h = await harness();
  const p = h.bridge.request("type", { text: "hunter2" }, T1);
  await h.reply({ ok: false, error: "포커스된 칸이 비밀번호(보안 입력) 칸이라 입력을 거부했습니다." });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error!, /비밀번호/);
  assert.equal(h.bridge.activityFor("s1").at(-1)!.ok, false);
  await h.bridge.flushLog();
  const log = await readFile(join(h.dir, "computer.log"), "utf8");
  assert.match(log, /글자 입력 \(7자\)/);
  assert.doesNotMatch(log, /hunter2/);
  h.bridge.dispose();
});

test("--pixels uses the session's last screenshot; the shot folder is private", async () => {
  const h = await harness();
  assert.match((await h.bridge.request("click", { x: 10, y: 10, space: "pixels" }, T1)).error!, /먼저 ao-computer screenshot/);
  const shot = h.bridge.request("screenshot", {}, T1);
  await h.reply({ ok: true, result: { path: "/tmp/sinawi-computer/shot-1-abc.png", width: 3024, height: 1964, scale: 2, rect: { x: 0, y: 0, w: 1512, h: 982 } } });
  assert.match(String(h.sent[0].args.out), /shots\/shot-\d+-\w+\.png$/);
  assert.equal((await shot).ok, true);
  assert.equal(((await stat(join(h.dir, "shots"))).mode & 0o777), 0o700);
  assert.equal(h.bridge.activityFor("s1").at(-1)!.image?.name, "shot-1-abc.png");
  const click = h.bridge.request("click", { x: 1000, y: 600, space: "pixels" }, T1);
  for (let i = 0; i < 100 && h.sent.length < 2; i++) await tick();
  assert.deepEqual({ x: h.sent[1].args.x, y: h.sent[1].args.y, space: h.sent[1].args.space }, { x: 500, y: 300, space: undefined });
  await h.reply({ ok: true, result: {} }, 1);
  await click;
  h.bridge.dispose();
});

test("status needs a token, not an approval, and reports the workspace gate", async () => {
  const h = await harness({ windows: () => 0 });
  h.setAllowed(false);
  const r = await h.bridge.request("status", {}, T1);
  assert.equal(r.ok, true);
  const value = r.result as Record<string, any>;
  assert.equal(value.allowed, false);
  assert.match(value.hint, /컴퓨터 조작이 꺼져/);
  assert.match(value.app.error, /열려 있지 않습니다/);
  h.bridge.dispose();
});

test("sessions that disappear lose their display approval", async () => {
  let alive = true;
  const h = await harness({ keyAlive: () => alive });
  const p = h.bridge.request("cursor", {}, T1);
  await h.reply({ ok: true, result: {}, grant: "session" });
  await p;
  alive = false;
  h.bridge.sweep();
  assert.equal(h.bridge.state().active, false);
  h.bridge.dispose();
});

test("run tokens resolve only while their session is running, and never from a session id", () => {
  clearComputerTokens();
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "w", agent: "codex" }, 1_000, 60_000);
  assert.match(token, /^[\w-]{32}$/);
  assert.equal(resolveComputerToken(token, 2_000)?.sessionId, "s1");
  assert.equal(resolveComputerToken(token, 61_000), undefined, "tokens expire");
  assert.equal(resolveComputerToken("s1"), undefined, "a session id is not a token");
  assert.equal(resolveComputerToken(undefined), undefined);

  const live = issueComputerToken({ sessionId: "s2", workspaceId: "w", agent: "claude" });
  const sessions = [{ id: "s2", status: "running", workspaceId: "w", agent: "auto", title: "메모" }];
  assert.deepEqual(computerContextForToken(live, sessions, () => "작업"), { key: "session:s2", sessionId: "s2", workspaceId: "w", agent: "claude", title: "메모", workspaceName: "작업" });
  assert.equal(computerContextForToken("nope", sessions, () => undefined), undefined);
  assert.equal(computerContextForToken(live, [{ ...sessions[0], status: "done" }], () => undefined), undefined, "the run ended");
  assert.equal(resolveComputerToken(live), undefined, "and its token is gone");

  const other = issueComputerToken({ sessionId: "s3", workspaceId: "w", agent: "grok" });
  pruneComputerTokens((id) => id !== "s3");
  assert.equal(resolveComputerToken(other), undefined);
});

test("each CLI run gets its own token; helper runs get none", () => {
  clearComputerTokens();
  const a = computerRunEnv("codex", { sessionId: "s1", workspaceId: "w", role: "worker" }, { TMPDIR: "/x" });
  const b = computerRunEnv("codex", { sessionId: "s1", workspaceId: "w", role: "orchestrator" }, { TMPDIR: "/x" });
  assert.equal(a.SINAWI_SESSION_ID, "s1");
  assert.ok(a.SINAWI_COMPUTER_TOKEN && b.SINAWI_COMPUTER_TOKEN && a.SINAWI_COMPUTER_TOKEN !== b.SINAWI_COMPUTER_TOKEN);
  assert.equal(resolveComputerToken(a.SINAWI_COMPUTER_TOKEN)?.agent, "codex");
  assert.ok(a.SINAWI_COMPUTER_DIR);
  assert.equal(computerRunEnv("claude", { sessionId: "r", workspaceId: "w", role: "router" }, { TMPDIR: "/x" }).SINAWI_COMPUTER_TOKEN, undefined);
  assert.deepEqual(computerRunEnv("claude", undefined), {});
});

test("server and CLI agree on one per-user folder", () => {
  const userTmp = () => "/var/folders/ab/cd/T/";
  assert.equal(resolveComputerDir({}, "darwin", 501, "/tmp", userTmp), "/var/folders/ab/cd/T/sinawi-computer-501");
  assert.equal(resolveComputerDir({ TMPDIR: "/elsewhere" }, "darwin", 501, "/elsewhere", userTmp), "/var/folders/ab/cd/T/sinawi-computer-501", "TMPDIR (set in shells, unset under launchd) does not matter");
  assert.equal(resolveComputerDir({ SINAWI_COMPUTER_DIR: "/srv/cu/" }, "darwin", 501, "/tmp", userTmp), "/srv/cu", "the server's choice wins in the CLI");
  assert.equal(resolveComputerDir({}, "darwin", 501, "/tmp/", () => undefined), "/tmp/sinawi-computer-501");
  assert.equal(resolveComputerDir({}, "linux", 1000, "/tmp", userTmp), "/tmp/sinawi-computer-1000");
  assert.match(CLI_SOURCE, /const resolveDir = function resolveComputerDir|const resolveDir = \(?function|resolveComputerDir/);
});

test("private folders are 0700 and must be real directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cu-dir-"));
  const dir = join(root, "a", "b");
  await ensurePrivateDir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await writeFile(join(root, "file"), "x");
  await assert.rejects(ensurePrivateDir(join(root, "file")));
});

test("skills install only for CLIs that are installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "cu-home-"));
  const pathDir = await mkdtemp(join(tmpdir(), "cu-path-"));
  await mkdir(join(home, ".claude"));
  await writeFile(join(pathDir, "grok"), "#!/bin/sh\n");
  const out = await installComputerTooling(home, pathDir);
  assert.deepEqual(out, { cli: true, skills: ["claude", "grok"] });
  assert.equal(await readFile(join(home, ".claude", "skills", "orchestra-computer", "SKILL.md"), "utf8"), SKILL_MD);
  assert.equal(await readFile(join(home, ".grok", "skills", "orchestra-computer", "SKILL.md"), "utf8"), SKILL_MD);
  await assert.rejects(stat(join(home, ".codex")), "no ~/.codex is created for a CLI that is not installed");
  const empty = await mkdtemp(join(tmpdir(), "cu-home-"));
  assert.deepEqual((await installComputerTooling(empty, "")).skills, []);
  assert.deepEqual((await readdir(empty)).sort(), [".local"]);
});

test("CLI ships the tested parser, needs a token, and the queue fallback answers", async () => {
  const home = await mkdtemp(join(tmpdir(), "cu-home-"));
  await installComputerTooling(home, "");
  const cli = join(home, ".local", "bin", "ao-computer");
  assert.equal(await readFile(cli, "utf8"), CLI_SOURCE);
  assert.match(SKILL_MD, /^---\nname: orchestra-computer\n/);
  const run = promisify(execFile);
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /ao-computer <명령>/);
  await assert.rejects(run(process.execPath, [cli, "explode"]), (e: { code: number; stderr: string }) => e.code === 2 && /알 수 없는 명령/.test(e.stderr));
  const env = { ...process.env, SINAWI_COMPUTER_TOKEN: "" };
  await assert.rejects(run(process.execPath, [cli, "cursor"], { env }), (e: { code: number; stderr: string }) => e.code === 1 && e.stderr.includes("SINAWI_COMPUTER_TOKEN"));

  // Queue path: a request file is answered by the watcher (no HTTP); only the token counts.
  const queue = await mkdtemp(join(tmpdir(), "cu-queue-"));
  const h = await harness();
  h.setAllowed(false);
  const stop = watchComputerQueue(h.bridge, queue, 10);
  const ask = async (name: string, body: unknown) => {
    await writeFile(join(queue, `${name}.req.tmp`), JSON.stringify(body));
    await rename(join(queue, `${name}.req.tmp`), join(queue, `${name}.req.json`));
    for (let i = 0; i < 200; i++) { await tick(); if ((await readdir(queue)).includes(`${name}.res.json`)) return JSON.parse(await readFile(join(queue, `${name}.res.json`), "utf8")); }
  };
  assert.equal((await ask("x", { action: "click", args: { x: 1, y: 1 }, token: "t1" })).error, computerUseBlockedMessage);
  assert.equal((await ask("y", { action: "click", args: { x: 1, y: 1 }, session: "s1" })).error, TOKEN_MESSAGE, "a session id alone is refused");
  stop();
  h.bridge.dispose();
});

test("userHalt reports a denial or a stop that happened during the run", async () => {
  const h = await harness();
  const since = Date.now();
  assert.equal(h.bridge.userHalt("s1", since), undefined);
  const p = h.bridge.request("cursor", {}, T1);
  await h.reply({ ok: false, error: `${NATIVE_DENIED}사용자가 거부` });
  await p;
  assert.equal(h.bridge.userHalt("s1", since), "denied");
  assert.equal(h.bridge.userHalt("s1", Date.now() + 1000), undefined, "an older denial does not halt a later run");
  assert.equal(h.bridge.userHalt("s2", since), undefined, "other sessions are not affected");

  const other = h.bridge.request("cursor", {}, { token: "t2" });
  for (let i = 0; i < 100 && h.sent.length < 2; i++) await tick();
  h.bridge.stop("user");
  assert.equal((await other).error, STOPPED_MESSAGE);
  assert.equal(h.bridge.userHalt("s2", since), "stopped");
  assert.equal(h.bridge.userHalt("s3", since), undefined, "a stop halts only sessions that were using the computer");
  h.bridge.dispose();
});
