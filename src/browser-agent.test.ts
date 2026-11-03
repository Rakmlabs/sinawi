import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentCommandError, claimCommand, commandForThisWorkspace, idleStatus, commandTargetsOwnApp, holdCommand, setBrowserWorkspace, isOwnAppUrl, replayCommand, takeHeldCommand, withTargetUrls, agentTabFor } from "./browser-agent";

test("agent commands need a proxied localhost tab", () => {
  assert.match(agentCommandError(undefined)!, /goto/);
  assert.match(agentCommandError({ frameUrl: "https://x.com", proxied: false, url: "https://x.com" })!, /외부 사이트/);
  assert.equal(agentCommandError({ frameUrl: "http://127.0.0.1:5000/", proxied: true }), undefined);
  assert.equal(isOwnAppUrl("http://localhost:3001"), true);
  assert.match(agentCommandError({ frameUrl: "http://127.0.0.1:5555/", proxied: true, url: "http://localhost:3001/" })!, /자체 주소/);
});

test("shell commands can be resent and every other command id runs once", () => {
  const id = `claim-${Date.now()}-${Math.random()}`;
  assert.equal(claimCommand(id), true);
  assert.equal(claimCommand(id), false);
  assert.equal(claimCommand(""), false);
  assert.equal(replayCommand("viewport"), true);
  assert.equal(replayCommand("status"), true);
  assert.equal(replayCommand("tabs"), true);
  assert.equal(replayCommand("click"), false);
  assert.equal(replayCommand("goto"), false);
  assert.equal(commandTargetsOwnApp("goto", { url: "http://localhost:3001/" }), true);
  assert.equal(commandTargetsOwnApp("goto", { url: "http://localhost:5173/" }), false);
  assert.equal(commandTargetsOwnApp("tab", { op: "new", url: "http://127.0.0.1:3001" }), true);
  assert.equal(commandTargetsOwnApp("tab", { op: "new", url: "" }), false);
  assert.equal(commandTargetsOwnApp("tab", { op: "select", url: "http://localhost:3001" }), false);
  const panel = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /claimCommand\(command\.id\)/);
  assert.match(panel, /commandTargetsOwnApp/);
  assert.match(panel, /runAgentRef/);
  assert.match(panel, /takeHeldCommand\(workspaceRef\.current/);
  const main = readFileSync(new URL("./app/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(main, /holdCommand\(detail\)/);
  assert.doesNotMatch(main, /__retry/);
  const desktop = readFileSync(new URL("./BrowserDesktop.tsx", import.meta.url), "utf8");
  assert.match(desktop, /useLayoutEffect\(\(\) => \{\s*if \(!request\.n\) return;/);
});

test("a command opened before any panel exists is held without a timer", () => {
  const command = { type: "browser-command" as const, id: `held-${Date.now()}`, action: "status", args: {} };
  holdCommand(command);
  assert.equal(takeHeldCommand(), command);
  assert.equal(takeHeldCommand(), undefined);
  holdCommand({ type: "browser-command", id: "", action: "status", args: {} });
  assert.equal(takeHeldCommand(), undefined);
});

test("proxy origins are rewritten to the dev server origin", () => {
  const out = withTargetUrls({ ok: true, result: { url: "http://127.0.0.1:5555/a", snapshot: "# t  http://127.0.0.1:5555/a", text: "at http://127.0.0.1:5555/a", href: "http://127.0.0.1:5555/a" } }, "http://127.0.0.1:5555", "http://localhost:3000");
  assert.deepEqual(out.result, { url: "http://localhost:3000/a", snapshot: "# t  http://localhost:3000/a", text: "at http://localhost:3000/a", href: "http://localhost:3000/a" });
});

test("status with no open page answers instead of failing", () => {
  assert.equal(idleStatus("status", undefined)?.ok, true);
  assert.equal(idleStatus("status", { frameUrl: "http://localhost:5173/" }), undefined);
  assert.equal(idleStatus("snapshot", undefined), undefined);
});

test("an agent's browser command runs only in its own workspace", () => {
  setBrowserWorkspace("company");
  assert.equal(commandForThisWorkspace({ workspaceId: "company" }), true);
  assert.equal(commandForThisWorkspace({ workspaceId: "personal" }), false);
  assert.equal(commandForThisWorkspace({}), true, "a command without a workspace (older CLI) still runs");
});

test("each agent keeps its own browser tab; a second session gets a new one", () => {
  const tabs = [{ id: "t1", url: "http://localhost:5173" }];
  // First session takes the page the user opened.
  assert.deepEqual(agentTabFor(tabs, "t1", "s1:orchestrator"), { id: "t1", claim: true });
  const owned = [{ id: "t1", url: "http://localhost:5173", owner: "s1:orchestrator" }];
  assert.deepEqual(agentTabFor(owned, "t1", "s1:orchestrator"), { id: "t1" });
  // Another session, or a worker of the same session, does not drive it.
  assert.deepEqual(agentTabFor(owned, "t1", "s2:orchestrator"), { create: true });
  assert.deepEqual(agentTabFor(owned, "t1", "s1:w2"), { create: true });
  // An empty unowned tab is reused before a new one is opened.
  const withBlank = [...owned, { id: "t2", url: "" }];
  assert.deepEqual(agentTabFor(withBlank, "t1", "s2:orchestrator"), { id: "t2", claim: true });
  // The owner's own tab wins even when the user is looking at another one.
  const two = [...owned, { id: "t3", url: "http://localhost:3000", owner: "s2:orchestrator" }];
  assert.deepEqual(agentTabFor(two, "t1", "s2:orchestrator"), { id: "t3" });
  assert.deepEqual(agentTabFor(two, "t1", "s2:orchestrator", "t3"), { id: "t3" });
  // A closed current tab falls back to the rules above; no owner keeps the old behaviour.
  assert.deepEqual(agentTabFor(two, "t1", "s1:orchestrator", "gone"), { id: "t1" });
  assert.deepEqual(agentTabFor(two, "t3", undefined), { id: "t3" });
});

test("a parked command waits for its own workspace's browser", () => {
  const company = { type: "browser-command" as const, id: "c1", action: "goto", args: {}, workspaceId: "company" };
  const loose = { type: "browser-command" as const, id: "l1", action: "status", args: {} };
  holdCommand(company);
  holdCommand(loose);
  assert.equal(takeHeldCommand("personal", false), undefined, "an off-screen personal browser takes neither");
  assert.equal(takeHeldCommand("personal", true), loose, "on screen, a command naming no workspace is taken");
  assert.equal(takeHeldCommand("company", true), company);
  assert.equal(takeHeldCommand("company", true), undefined);
});
