import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Express } from "express";
import { createServer } from "./server.js";

function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req); res.assignSocket(socket as never); res.on("error", reject); socket.on("error", reject);
    res.on("finish", () => {
      try {
        const payload = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : undefined });
      } catch (error) { reject(error); } finally { socket.destroy(); }
    });
    app(req, res); if (json) req.push(json); req.complete = true; req.push(null);
  });
}

test("tools API returns workspace-aware MCP and skill states and persists toggles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-tools-api-"));
  const codexConfigPath = join(directory, "config.toml");
  await writeFile(codexConfigPath, "[mcp_servers.bbanana]\nenabled = true\n");
  const calls: Array<[string, string[]]> = [];
  const toolRunner = async (file: string, args: string[]) => {
    calls.push([file, args]);
    if (args[1] === "list") return { stdout: file === "claude" ? "docs: claude-docs - Connected\n" : "bbanana  https://banana.test/mcp  enabled\n" };
    return { stdout: "" };
  };
  const fixtureSkills = async () => [{ id: "review-id", name: "Review", source: "Test", agents: ["codex" as const], description: "Review code" }];
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("fixture"); }, toolRunner, codexConfigPath, toolSkillLoader: fixtureSkills });
  try {
    const personal = await request(app, "GET", "/api/tools?workspace=personal");
    assert.equal(personal.status, 200);
    assert.deepEqual(personal.body.skills, [{ name: "Review", source: "Test", agents: ["codex"], description: "Review code", enabled: true }]);
    const disabled = await request(app, "PUT", "/api/tools/skill", { name: "Review", enabled: false, workspace: "personal" });
    assert.equal(disabled.body.skills[0].enabled, false);
    assert.equal((await request(app, "GET", "/api/tools?workspace=work")).body.skills[0].enabled, true);

    const claude = await request(app, "PUT", "/api/tools/mcp", { agent: "claude", name: "docs", enabled: false, workspace: "personal" });
    assert.equal(claude.body.mcp.find((item: any) => item.agent === "claude").appEnabled, false);
    assert.ok(!calls.some(([file, args]) => file === "claude" && args[1] !== "list"));
    const grok = await request(app, "PUT", "/api/tools/mcp", { agent: "grok", name: "bbanana", enabled: false, workspace: "personal" });
    assert.equal(grok.status, 200);
    assert.ok(calls.some(([file, args]) => file === "grok" && args.join(" ") === "mcp disable bbanana"));
    assert.equal((await request(app, "PUT", "/api/tools/mcp", { agent: "grok", name: "bbanana", enabled: true, workspace: "company" })).status, 400);
    const company = await request(app, "GET", "/api/tools?workspace=company");
    assert.ok(company.body.mcp.filter((item: any) => item.name === "bbanana").every((item: any) => item.forcedOff && item.status === "locked"));
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("disabled skills are excluded from workspace skill discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-tools-skills-"));
  const cwd = join(directory, "project");
  await mkdir(join(cwd, ".agents", "skills", "workspace-review"), { recursive: true });
  await writeFile(join(cwd, ".agents", "skills", "workspace-review", "SKILL.md"), "---\nname: Workspace Review\ndescription: Review fixture\n---\n");
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("fixture"); }, toolRunner: async () => ({ stdout: "" }) });
  try {
    assert.ok((await request(app, "GET", `/api/skills?cwd=${encodeURIComponent(cwd)}&workspace=company`)).body.some((skill: any) => skill.name === "Workspace Review"));
    await request(app, "PUT", "/api/tools/skill", { name: "Workspace Review", enabled: false, workspace: "company" });
    assert.ok(!(await request(app, "GET", `/api/skills?cwd=${encodeURIComponent(cwd)}&workspace=company`)).body.some((skill: any) => skill.name === "Workspace Review"));
    assert.ok((await request(app, "GET", `/api/skills?cwd=${encodeURIComponent(cwd)}&workspace=personal`)).body.some((skill: any) => skill.name === "Workspace Review"));
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});

test("tools API includes skills from the requested working folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestra-tools-cwd-"));
  const seen: Array<string | undefined> = [];
  const toolSkillLoader = async (cwd?: string) => {
    seen.push(cwd);
    return [{ id: "local", name: "Local", source: "프로젝트", agents: ["codex" as const], description: "Local skill" }];
  };
  const { app, websocket } = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: [], modelRunner: async () => { throw new Error("fixture"); }, toolRunner: async () => ({ stdout: "" }), toolSkillLoader });
  try {
    const response = await request(app, "GET", `/api/tools?workspace=personal&cwd=${encodeURIComponent(directory)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.skills[0].name, "Local");
    assert.equal(seen.at(-1), directory);
    await request(app, "PUT", "/api/tools/skill", { name: "Local", enabled: false, workspace: "personal", cwd: directory });
    assert.equal(seen.at(-1), directory);
  } finally { websocket.close(); await rm(directory, { recursive: true, force: true }); }
});
