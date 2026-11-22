import assert from "node:assert/strict";
import test from "node:test";
import { originLabel } from "./origin";
import { threadTabs } from "./lead";
import type { Session } from "../server/types";

test("known MCP clients read as their product; other names and leads stay as given", () => {
  assert.equal(originLabel({ kind: "mcp", client: "claude-code" }), "Claude Code");
  assert.equal(originLabel({ kind: "mcp", client: "codex-mcp-client" }), "Codex");
  assert.equal(originLabel({ kind: "mcp", client: "grok-bot" }), "Grok Bot");
  assert.equal(originLabel({ kind: "mcp", client: "Grok Build" }), "Grok Build");
  assert.equal(originLabel({ kind: "mcp", client: "my-orchestrator" }), "my-orchestrator");
  assert.equal(originLabel({ kind: "lead", client: "codex" }), "codex", "a lead named like a client keeps its name");
  assert.equal(originLabel(undefined), "");
});

test("a lead's tabs are its own chats oldest first, without goal chats or other leads' chats", () => {
  const chat = (id: string, createdAt: string, extra: Partial<Session> = {}) => ({ id, createdAt, title: id, steward: { id: "L", turns: 0, since: "" }, ...extra }) as Session;
  const sessions = [
    chat("b", "2026-11-02"), chat("a", "2026-11-01"), chat("child", "2026-11-03", { parentId: "a" }),
    chat("other", "2026-11-01", { steward: { id: "M", turns: 0, since: "" } }), chat("plain", "2026-11-01", { steward: undefined }),
  ];
  assert.deepEqual(threadTabs(sessions, "L").map((session) => session.id), ["a", "b"]);
});
