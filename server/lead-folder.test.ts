// A new lead never starts in the home folder (or /), whoever asks: the app already makes the user pick
// a folder; the HTTP API, an outside AI's create_lead and a lead creating another lead are refused too.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectRequest } from "./app-tools.js";
import { assertLeadFolder, Orchestra } from "./orchestra.js";
import { createServer } from "./server.js";

test("the home folder, /, and the folders above home are refused as a lead's folder; a project folder is fine", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sinawi-lead-home-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = join(root, "Users", "me");
  await mkdir(join(home, "project"), { recursive: true });
  assert.throws(() => assertLeadFolder(home, home), /프로젝트 폴더/u);
  assert.throws(() => assertLeadFolder(`${home}/`, home));
  assert.throws(() => assertLeadFolder(`${home}/.`, home));
  assert.throws(() => assertLeadFolder(`${home}/project/..`, home));
  assert.throws(() => assertLeadFolder("/", home));
  assert.throws(() => assertLeadFolder(join(root, "Users"), home), /프로젝트 폴더/u, "a folder that holds the home folder");
  assert.doesNotThrow(() => assertLeadFolder(join(home, "project"), home));
  assert.doesNotThrow(() => assertLeadFolder(undefined, home));
});

// The third review's bypasses: another spelling of the same folder, and paths that are not folders.
test("another spelling of the home folder is still the home folder: letter case, a symlink, ~ and missing paths", async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "sinawi-lead-spelling-")));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const home = homedir();
  const link = join(scratch, "homelink");
  await symlink(home, link);
  assert.throws(() => assertLeadFolder(link, home), /프로젝트 폴더/u, "a symlink to home");
  const upper = home.toUpperCase();
  // On a case-insensitive disk (APFS default) /USERS/me is the home folder; elsewhere it does not exist.
  assert.throws(() => assertLeadFolder(upper, home));
  assert.throws(() => assertLeadFolder(home.toLowerCase() === home ? upper : home.toLowerCase(), home));
  assert.throws(() => assertLeadFolder("~", home), /절대 경로/u);
  assert.throws(() => assertLeadFolder(join(scratch, "nope"), home), /없거나/u);
  await writeFile(join(scratch, "file"), "x");
  assert.throws(() => assertLeadFolder(join(scratch, "file"), home), /없거나/u);
});

test("creating or moving a lead to the home folder is refused in the orchestra itself", async () => {
  const orchestra = new Orchestra(undefined, async () => ({ exitCode: 0, finalText: "ok" }));
  assert.throws(() => orchestra.createSteward({ name: "홈 담당", cwds: [homedir()] }), /프로젝트 폴더/u);
  await assert.rejects(orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd: homedir(), steward: { name: "홈" } }), /프로젝트 폴더/u);
  const lead = orchestra.createSteward({ name: "프로젝트 담당", cwds: [tmpdir()] });
  assert.throws(() => orchestra.patchSteward(lead.id, { cwds: [homedir()] }), /프로젝트 폴더/u);
  // A new chat of an existing lead opened in the home folder is refused, and home never joins the lead's folders.
  await assert.rejects(orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd: homedir(), steward: { id: lead.id } }), /프로젝트 폴더/u);
  await assert.rejects(orchestra.create({ prompt: "", agent: "codex", workers: ["claude"], cwd: homedir().toUpperCase(), steward: { id: lead.id } }));
  assert.deepEqual(orchestra.listStewards().find((item) => item.id === lead.id)?.cwds, [tmpdir()]);
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
  // The review's repros: /USERS/<me> (APFS ignores case), a symlink to home, and a chat of an existing lead.
  assert.equal((await call("POST", "/api/stewards", { name: "대문자", cwds: [homedir().toUpperCase()] })).status, 400);
  const link = join(directory, "homelink");
  await symlink(homedir(), link);
  assert.equal((await call("POST", "/api/stewards", { name: "링크", cwds: [link] })).status, 400);
  assert.equal((await call("POST", "/api/sessions", { prompt: "", agent: "codex", workers: ["claude"], cwd: homedir().toUpperCase(), steward: { name: "대문자 2" } })).status, 400);
  const project = join(directory, "project");
  await mkdir(project);
  const made = await call("POST", "/api/stewards", { name: "프로젝트", cwds: [project] }) as { status: number; body: { id?: string } };
  assert.equal(made.status, 201);
  assert.equal((await call("POST", "/api/sessions", { prompt: "", agent: "codex", workers: ["claude"], cwd: homedir(), steward: { id: made.body.id } })).status, 400);
  const after = await call("GET", `/api/stewards/${made.body.id}`, undefined) as { status: number; body: { cwds?: string[] } };
  assert.deepEqual(after.body.cwds, [project], "home never joins the lead's folders");
});
