// An outside orchestrator (Grok Bot, Codex, Claude Code ...) driving Sinawi over MCP: it opens a chat
// of a lead with the model it wants, waits for the answer, continues in the same chat, and the chat
// shows who asked. Runs the real routes and Orchestra with a fake `claude` CLI (no network, no login).
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectRequest } from "./app-tools.js";
import { createServer, mcpClientName, requestOrigin } from "./server.js";
import { waitResult } from "./session-wait.js";
import type { Session, SessionEvent } from "./types.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args.includes("--help")) { console.log("Usage: claude [options]"); process.exit(0); }
let input = "";
const reply = (prompt) => {
  const last = prompt.trim().split("\\n").filter(Boolean).at(-1) || "";
  const text = "답: " + last;
  const out = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
  out({ type: "system", subtype: "init", session_id: "fake-1" });
  out({ type: "assistant", session_id: "fake-1", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-1" });
  process.exit(0);
};
const p = args.indexOf("-p");
if (p >= 0 && args[p + 1] && !args[p + 1].startsWith("-")) reply(args[p + 1]);
else { process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => reply(input)); }
`;

async function harness(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-mcp-orchestrator-"));
  const project = join(directory, "project");
  await import("node:fs/promises").then((fs) => fs.mkdir(project));
  const fake = join(directory, "claude");
  await writeFile(fake, FAKE_CLAUDE);
  await chmod(fake, 0o755);
  const saved = process.env.SINAWI_CLAUDE_BIN;
  process.env.SINAWI_CLAUDE_BIN = fake;
  const created = createServer({ dataDir: directory, modelHomeDir: directory, staticDir: directory, availableAgents: ["claude"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => {
    for (const session of created.orchestra.list()) if (session.status === "running") created.orchestra.stop(session.id);
    created.httpServer.close(); created.websocket.close();
    await created.flushSessions().catch(() => undefined);
    if (saved === undefined) delete process.env.SINAWI_CLAUDE_BIN; else process.env.SINAWI_CLAUDE_BIN = saved;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(directory, { recursive: true, force: true });
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers, 60_000) as Promise<{ status: number; body: any }>;
  const token = (await call("GET", "/api/app-mcp/connection")).body.token as string;
  let id = 0;
  /** One MCP call the way the bridge sends it: the token and the client's name. */
  const mcp = async (name: string, args: Record<string, unknown>, client = "grok-bot") => {
    const answer = await call("POST", "/api/app-mcp", { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}`, "x-sinawi-client": encodeURIComponent(client) });
    const text = answer.body.result?.content?.[0]?.text ?? JSON.stringify(answer.body);
    if (answer.body.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { call, mcp, project, created };
}

test("an outside orchestrator opens a lead's chat with its own model, waits for the answer and continues in it; the chat shows who asked", async (t) => {
  const { call, mcp, project, created } = await harness(t);
  const lead = (await call("POST", "/api/stewards", { name: "데모", agent: "claude", cwds: [project], workers: [{ agent: "claude" }] })).body;
  assert.ok(lead.id, JSON.stringify(lead));

  const opened = await mcp("create_session", { lead_id: lead.id, prompt: "로그인 버그 원인 찾아줘", title: "로그인 버그", agent: "claude", model: "sonnet" });
  assert.equal(opened.lead.id, lead.id);
  assert.equal(opened.openedBy, "grok-bot (mcp)");
  const session = created.orchestra.get(opened.id)!;
  assert.deepEqual(session.origin, { kind: "mcp", client: "grok-bot" });
  assert.equal(session.model, "sonnet", "the thread runs the model the orchestrator picked, not the lead's");
  assert.equal(session.steward?.id, lead.id, "still one of the lead's chats");
  const first = session.events.find((event) => event.agent === "user" && event.type === "message")!;
  assert.deepEqual(first.metadata?.via, { kind: "mcp", client: "grok-bot" });

  const done = await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  assert.equal(done.done, true, JSON.stringify(done));
  assert.equal(done.status, "done");
  assert.match(done.lastAnswer, /답: /u);
  assert.equal(done.messages[0].from, "grok-bot");
  assert.ok(done.messages.some((message: { from: string }) => message.from === "claude"));

  await mcp("send_message", { session_id: opened.id, prompt: "그럼 고쳐줘" });
  const next = await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30, after_event_id: done.lastEventId });
  assert.equal(next.done, true);
  assert.deepEqual(next.messages.map((message: { from: string }) => message.from), ["grok-bot", "claude"], "only what was said after the last read");
  assert.match(next.lastAnswer, /그럼 고쳐줘/u);

  // The user keeps talking in the same chat from the app: no origin on that message.
  assert.equal((await call("POST", `/api/sessions/${opened.id}/messages`, { prompt: "내가 직접 이어서" })).status, 200);
  await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 30 });
  const mine = created.orchestra.get(opened.id)!.events.filter((event: SessionEvent) => event.agent === "user" && event.type === "message").at(-1)!;
  assert.equal(mine.text, "내가 직접 이어서");
  assert.equal(mine.metadata?.via, undefined);

  // Review L3: a model is a name, never an option for the CLI.
  const bad = await call("POST", "/api/sessions", { prompt: "x", cwd: project, agent: "claude", model: "--help", workers: ["claude"] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /모델 이름이 올바르지 않습니다/u);
  const listed = await mcp("list_sessions", { lead_id: lead.id });
  assert.deepEqual(listed.map((row: { id: string }) => row.id), [opened.id]);
  const shown = await mcp("show_session", { session_id: opened.id });
  assert.equal(shown.ok, true);
  // Review M3: a notification says who asks; the window decides whether to switch (src/app/show-session.ts).
  const notes = (await call("GET", "/api/notifications")).body as { key?: string; title: string; action?: { sessionId?: string } }[];
  const asked = notes.find((note) => note.key === `show:${opened.id}`);
  assert.equal(asked?.title, "Grok Bot: 이 채팅을 봐 달라고 합니다");
  assert.equal(asked?.action?.sessionId, opened.id);
});

test("a lead's new chat without agent or model keeps the lead's own CLI and model", async (t) => {
  const { call, mcp, project, created } = await harness(t);
  const lead = (await call("POST", "/api/stewards", { name: "기본", agent: "claude", model: "opus", cwds: [project], workers: [{ agent: "claude" }] })).body;
  const opened = await mcp("create_session", { lead_id: lead.id, title: "빈 채팅" }, "codex-mcp-client");
  const session = created.orchestra.get(opened.id) as Session;
  assert.equal(session.model, "opus");
  assert.deepEqual(session.origin, { kind: "mcp", client: "codex-mcp-client" });
  const waited = await mcp("wait_for_session", { session_id: opened.id, timeout_sec: 1 });
  assert.equal(waited.done, true, "an empty chat has nothing running");
});

test("an approval an outside AI asks for names that AI on the card", async (t) => {
  const { call, mcp, project } = await harness(t);
  const opened = await mcp("create_session", { cwd: project, title: "지울 채팅" });
  const asked = await mcp("delete_session", { session_id: opened.id }, "Grok Bot");
  assert.equal(asked.status, "pending_approval", JSON.stringify(asked));
  const listed = (await call("GET", "/api/app-approvals")).body as Array<{ id: string; requester?: string; source: string }>;
  const item = (Array.isArray(listed) ? listed : (listed as { approvals: typeof listed }).approvals).find((entry) => entry.id === asked.approvalId)!;
  assert.equal(item.source, "external");
  assert.equal(item.requester, "Grok Bot");
});

test("wait_for_session on a missing chat is an error, not a hang", async (t) => {
  const { mcp } = await harness(t);
  await assert.rejects(mcp("wait_for_session", { session_id: "nope", timeout_sec: 5 }), /찾을 수 없/u);
});

test("the client name comes from the bridge's header, else the initialize message, and is cleaned", () => {
  assert.equal(mcpClientName(encodeURIComponent("Grok Bot")), "Grok Bot");
  assert.equal(mcpClientName(undefined, { method: "initialize", params: { clientInfo: { name: "claude-code" } } }), "claude-code");
  assert.equal(mcpClientName(undefined, { method: "tools/call" }), "MCP");
  assert.equal(mcpClientName("%E0%A4%A"), "%E0%A4%A", "a broken encoding is kept as text");
  assert.equal(requestOrigin({ kind: "mcp", client: "<b>x</b>\u0007" })!.client, "bx/b");
  assert.equal(requestOrigin({ kind: "admin", client: "x" }), undefined);
  assert.equal(requestOrigin({ kind: "mcp", client: "a".repeat(200) })!.client.length, 60);
});

test("waitResult: not done while working, messages after a given event, worker logs left out", () => {
  const event = (id: string, agent: SessionEvent["agent"], text: string, extra: Partial<SessionEvent> = {}): SessionEvent => ({ id, sessionId: "s", agent, type: "message", text, time: "2026-11-21T00:00:00.000Z", ...extra });
  const session = {
    id: "s", title: "t", agent: "claude", workers: ["claude"], cwd: "/tmp", status: "running", createdAt: "", workspaceId: "default",
    events: [
      event("1", "user", "해줘", { metadata: { via: { kind: "mcp", client: "Grok Bot" } } }),
      event("2", "claude", "작업 중", { role: "worker" }),
      event("3", "claude", "첫 답", { role: "orchestrator" }),
      event("4", "claude", "CLI 세션 연결됨", { type: "status" }),
    ],
  } as Session;
  const running = waitResult(session, true);
  assert.equal(running.done, false);
  assert.deepEqual(running.messages.map((message) => [message.from, message.text]), [["Grok Bot", "해줘"], ["claude", "첫 답"]]);
  assert.equal(running.messages[0].sentBy, "Grok Bot (mcp)");
  assert.equal(running.lastEventId, "4");
  assert.deepEqual(waitResult(session, false, "1").messages.map((message) => message.id), ["3"]);
  assert.deepEqual(waitResult(session, false, "gone").messages.map((message) => message.id), ["1", "3"], "an unknown id reads from the start");
  assert.equal(waitResult(session, false).done, true);
});
