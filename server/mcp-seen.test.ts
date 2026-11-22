// The connect page answers "is the outside AI connected?" from requests that reached the server.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectRequest } from "./app-tools.js";
import { forgetMcpClients, mcpClientsSeen, noteMcpClient } from "./mcp-seen.js";
import { createServer } from "./server.js";

test("clients are listed most recent first, with their request count, and the list stays bounded", () => {
  forgetMcpClients();
  noteMcpClient("a", new Date("2026-01-01T00:00:00Z"));
  noteMcpClient("b", new Date("2026-01-01T00:01:00Z"));
  noteMcpClient("a", new Date("2026-01-01T00:02:00Z"));
  assert.deepEqual(mcpClientsSeen(), [
    { client: "a", at: "2026-01-01T00:02:00.000Z", calls: 2 },
    { client: "b", at: "2026-01-01T00:01:00.000Z", calls: 1 },
  ]);
  for (let index = 0; index < 30; index += 1) noteMcpClient(`c${index}`);
  assert.equal(mcpClientsSeen().length, 20);
  assert.equal(mcpClientsSeen()[0]?.client, "c29");
  forgetMcpClients();
});

test("only a request with the right token shows on the connect page, under the client's name", async (t) => {
  forgetMcpClients();
  const directory = await mkdtemp(join(tmpdir(), "sinawi-mcp-seen-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, staticDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => { forgetMcpClients(); created.httpServer.close(); created.websocket.close(); await new Promise((resolve) => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => injectRequest(created.app as never, method, path, body, headers) as Promise<{ status: number; body: any }>;
  const first = (await call("GET", "/api/app-mcp/connection")).body;
  assert.deepEqual(first.seen, []);
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await call("POST", "/api/app-mcp", list, { authorization: "Bearer wrong", "x-sinawi-client": "intruder" })).status, 401);
  assert.equal((await call("POST", "/api/app-mcp", list, { authorization: `Bearer ${first.token}`, "x-sinawi-client": "claude-code" })).status, 200);
  const seen = (await call("GET", "/api/app-mcp/connection")).body.seen as Array<{ client: string; calls: number }>;
  assert.deepEqual(seen.map(({ client, calls }) => ({ client, calls })), [{ client: "claude-code", calls: 1 }]);
});
