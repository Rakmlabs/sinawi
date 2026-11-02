import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import express from "express";
import { buildInvocation } from "./cli.js";
import { issueComputerToken } from "./computer-tokens.js";
import { ensurePermissionServerScript, PERMISSION_TOOL, pendingPermissions, permissionDetail, registerPermissionRoutes, registerRunActivity, unregisterRunActivity } from "./permission-prompts.js";

async function serve(timeoutMs?: number) {
  const pushed: unknown[] = [];
  const app = express().use(express.json());
  registerPermissionRoutes(app, { broadcast: (payload) => pushed.push(payload), timeoutMs });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const ask = (token: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/permissions/request`, { method: "POST", headers: { "content-type": "application/json", "x-sinawi-token": token }, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const answer = (id: string, allow: boolean) => fetch(`http://127.0.0.1:${port}/api/permissions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allow }) });
  const waitPending = async () => { for (let i = 0; i < 200 && !pendingPermissions().length; i++) await new Promise((r) => setTimeout(r, 10)); return pendingPermissions(); };
  return { port, pushed, ask, answer, waitPending, close: () => server.close() };
}

test("a question waits for the user's answer and returns Claude's allow/deny shape", async () => {
  const s = await serve();
  const token = issueComputerToken({ sessionId: "s1", workspaceId: "company", agent: "claude" });
  try {
    const allowed = s.ask(token, { tool_name: "Read", input: { file_path: "/repo/docs/a.md" } });
    const [request] = await s.waitPending();
    assert.equal(request.sessionId, "s1");
    assert.equal(request.workspaceId, "company");
    assert.equal(request.detail, "/repo/docs/a.md");
    assert.ok(s.pushed.some((p) => (p as { type: string }).type === "permissions"));
    assert.equal((await s.answer(request.id, true)).status, 200);
    assert.deepEqual((await allowed).body, { behavior: "allow", updatedInput: { file_path: "/repo/docs/a.md" } });
    assert.equal(pendingPermissions().length, 0);

    const denied = s.ask(token, { tool_name: "Bash", input: { command: "rm -rf build" } });
    const [second] = await s.waitPending();
    await s.answer(second.id, false);
    assert.equal((await denied).body.behavior, "deny");
    assert.equal((await s.answer(second.id, true)).status, 404, "an answered question cannot be answered again");
  } finally { s.close(); }
});

test("unknown runs are refused; unanswered questions and ended runs are denied", async () => {
  const s = await serve(50);
  try {
    assert.equal((await s.ask("nope", { tool_name: "Read", input: {} })).status, 403);
    const token = issueComputerToken({ sessionId: "s2", workspaceId: "personal", agent: "claude" });
    assert.equal((await s.ask(token, { tool_name: "Read", input: {} })).body.behavior, "deny");
  } finally { s.close(); }
  const t2 = await serve();
  try {
    const token = issueComputerToken({ sessionId: "s3", workspaceId: "personal", agent: "claude" });
    let alive = 0;
    registerRunActivity(token, () => { alive++; });
    const waiting = t2.ask(token, { tool_name: "Read", input: {} });
    await t2.waitPending();
    unregisterRunActivity(token);
    assert.equal((await waiting).body.behavior, "deny");
  } finally { t2.close(); }
});

test("the generated MCP server forwards Claude's tool call to Sinawi", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sinawi-perm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await ensurePermissionServerScript(dir);
  const s = await serve();
  const token = issueComputerToken({ sessionId: "s4", workspaceId: "personal", agent: "claude" });
  const child = spawn(process.execPath, [script], { env: { ...process.env, SINAWI_COMPUTER_TOKEN: token, SINAWI_PORT: String(s.port) }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    const replies: Array<{ id: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
    const reply = async (id: number) => { for (let i = 0; i < 300; i++) { const found = replies.find((r) => r.id === id); if (found) return found; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`no reply ${id}`); };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await reply(1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(`mcp__sinawi_permission__${(await reply(2)).result?.tools?.[0].name}`, PERMISSION_TOOL);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Read", input: { file_path: "/x" } } } });
    const [request] = await s.waitPending();
    await s.answer(request.id, true);
    assert.deepEqual(JSON.parse((await reply(3)).result?.content?.[0].text ?? "{}"), { behavior: "allow", updatedInput: { file_path: "/x" } });
  } finally { child.kill(); s.close(); }
});

test("only writable, non-full Claude runs route permission prompts to the app", () => {
  const base = { agent: "claude" as const, prompt: "work", cwd: "/repo", permissionMcp: '{"mcpServers":{}}' };
  const writable = buildInvocation(base).args;
  assert.equal(writable[writable.indexOf("--permission-prompt-tool") + 1], PERMISSION_TOOL);
  assert.ok(!buildInvocation({ ...base, readOnly: true }).args.includes("--permission-prompt-tool"));
  assert.ok(!buildInvocation({ ...base, fullAccess: true }).args.includes("--permission-prompt-tool"));
  assert.equal(permissionDetail({ command: "npm run build" }), "npm run build");
});
