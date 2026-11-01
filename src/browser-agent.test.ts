import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentCommandError, claimCommand, commandTargetsOwnApp, holdCommand, isOwnAppUrl, replayCommand, takeHeldCommand, withTargetUrls } from "./browser-agent";

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
  assert.match(panel, /takeHeldCommand\(\)/);
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
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
