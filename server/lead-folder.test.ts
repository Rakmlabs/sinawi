// A new lead never starts in the home folder (or /), whoever asks: the app already makes the user pick
// a folder; the HTTP API, an outside AI's create_lead and a lead creating another lead are refused too.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectRequest } from "./app-tools.js";
import { assertLeadFolder, Orchestra } from "./orchestra.js";
import { createServer } from "./server.js";

test("the home folder and / are refused as a lead's folder; a project folder is fine", () => {
  assert.throws(() => assertLeadFolder("/Users/me", "/Users/me"), /프로젝트 폴더/u);
  assert.throws(() => assertLeadFolder("/Users/me/", "/Users/me"));
  assert.throws(() => assertLeadFolder("/", "/Users/me"));
  assert.doesNotThrow(() => assertLeadFolder("/Users/me/project", "/Users/me"));
  assert.doesNotThrow(() => assertLeadFolder(undefined, "/Users/me"));
});

test("creating or moving a lead to the home folder is refused in the orchestra itself", async () => {
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "ok" }));
  assert.throws(() => orchestra.createSteward({ name: "홈 담당", cwds: [homedir()] }), /프로젝트 폴더/u);
  await assert.rejects(orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd: homedir(), steward: { name: "홈" } }), /프로젝트 폴더/u);
  const lead = orchestra.createSteward({ name: "프로젝트 담당", cwds: [tmpdir()] });
  assert.throws(() => orchestra.patchSteward(lead.id, { cwds: [homedir()] }), /프로젝트 폴더/u);
  // An ordinary chat (not a lead) may still use the home folder.
  const chat = await orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd: homedir() });
  assert.equal(chat.cwd, homedir());
});

// The review's repro: POST /api/sessions {cwd: $HOME, steward: {...}} answered 201.
test("the HTTP API refuses a new lead in the home folder, and create_lead's route too", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sinawi-lead-folder-"));
  const created = createServer({ dataDir: directory, modelHomeDir: directory, availableAgents: ["claude", "codex"], modelRunner: async () => { throw new Error("No CLI in fixture"); }, routingSkillLoader: async () => [] });
  t.after(async () => { created.httpServer.close(); created.websocket.close(); await created.flushSessions().catch(() => undefined); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const call = (method: string, path: string, body: unknown) => injectRequest(created.app as never, method, path, body, {}, 10_000, false) as Promise<{ status: number; body: { error?: string } }>;
  const session = await call("POST", "/api/sessions", { prompt: "", agent: "codex", workers: ["claude"], cwd: homedir(), steward: { name: "홈 담당" } });
  assert.equal(session.status, 400);
  assert.match(session.body.error ?? "", /프로젝트 폴더/u);
  const lead = await call("POST", "/api/stewards", { name: "홈 담당 2", cwds: [homedir()] });
  assert.equal(lead.status, 400);
});
