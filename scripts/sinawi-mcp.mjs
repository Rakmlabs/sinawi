#!/usr/bin/env node
// Sinawi's tools for any MCP client (Claude Desktop, Claude Code, Codex, ...), over stdio.
// Forwards every JSON-RPC line to the running app's POST /api/app-mcp with the app's external token.
//
//   SINAWI_URL        app address (default http://127.0.0.1:3001)
//   SINAWI_MCP_TOKEN  the token from Sinawi settings → 일반 → 외부 AI 연결
//   SINAWI_MCP_TOKEN_FILE / SINAWI_DATA_DIR  read the token from the app's data folder instead
//
// No dependencies: runs with plain Node 18+.
import * as http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

const base = new URL(process.env.SINAWI_URL || `http://127.0.0.1:${process.env.SINAWI_PORT || "3001"}`);

function readToken() {
  if (process.env.SINAWI_MCP_TOKEN) return process.env.SINAWI_MCP_TOKEN.trim();
  const dataDir = process.env.SINAWI_DATA_DIR || join(homedir(), "Library", "Application Support", "dev.sinawi.app", ".data");
  const file = process.env.SINAWI_MCP_TOKEN_FILE || join(dataDir, "app-mcp-token");
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// node:http, not fetch: some calls (waiting on a run) can outlast fetch's header timeout.
const post = (body, token) => new Promise((resolve, reject) => {
  const req = http.request({
    host: base.hostname, port: base.port || 80, path: "/api/app-mcp", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${token}` },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => resolve({ status: res.statusCode || 0, text }));
  });
  req.on("error", reject);
  req.end(body);
});

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.id === undefined || message.id === null) return;
  // Read on each call: a token renewed in the app works without restarting the client.
  const token = readToken();
  if (!token) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Sinawi MCP token missing: set SINAWI_MCP_TOKEN (Sinawi settings → 외부 AI 연결)." } });
    return;
  }
  try {
    const res = await post(JSON.stringify(message), token);
    let data;
    try { data = JSON.parse(res.text); } catch { data = undefined; }
    if (data && data.jsonrpc) send(data);
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: (data && data.error) || `Sinawi answered ${res.status}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `Sinawi is not reachable at ${base.origin}: ${(error && error.message) || error}` } });
  }
});
