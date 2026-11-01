import test from "node:test";
import assert from "node:assert/strict";
import { initialProgress, loadProgress, loginStatus, readyAgents, saveProgress, shouldAutoOpen, STEPS, toolsStatus } from "./onboarding-state";
import type { SetupTool } from "../server/setup";

const tool = (id: string, agent: boolean, installed: boolean) => ({ id, name: id, agent, installed, install: "x", docs: "https://x" }) as SetupTool;
const base = [tool("node", false, true), tool("npm", false, true), tool("git", false, true)];

test("first launch opens the helper; completed or skipped stays closed while an agent is ready", () => {
  assert.equal(shouldAutoOpen(initialProgress(), undefined, false), true);
  assert.equal(shouldAutoOpen({ ...initialProgress(), completed: true }, ["grok"], false), false);
  assert.equal(shouldAutoOpen({ ...initialProgress(), skipped: true }, ["claude"], false), false);
  assert.equal(shouldAutoOpen({ ...initialProgress(), completed: true }, [], false), true);
  assert.equal(shouldAutoOpen({ ...initialProgress(), completed: true }, [], true), false);
});

test("at least one installed, logged-in agent CLI is required; the others are optional", () => {
  const tools = [...base, tool("claude", true, true), tool("codex", true, false), tool("grok", true, true)];
  assert.deepEqual(readyAgents(tools, { claude: "unauthenticated", grok: "authenticated" }), ["grok"]);
  assert.equal(toolsStatus(tools), "ok");
  assert.equal(toolsStatus([...base, tool("claude", true, false)]), "warn");
  assert.equal(toolsStatus([tool("git", false, false), tool("grok", true, true)]), "warn");
  assert.equal(loginStatus(tools, { grok: "authenticated" }), "ok");
  assert.equal(loginStatus(tools, { grok: "unknown" }), "warn");
});

test("progress persists and survives garbage", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  saveProgress({ step: 3, completed: false, skipped: true, acknowledged: ["screen"] }, storage);
  assert.deepEqual(loadProgress(storage), { step: 3, completed: false, skipped: true, acknowledged: ["screen"] });
  mem.set("orchestra.onboarding", "{bad");
  assert.deepEqual(loadProgress(storage), initialProgress());
  mem.set("orchestra.onboarding", JSON.stringify({ step: 99 }));
  assert.equal(loadProgress(storage).step, STEPS.length - 1);
});

import { permissionView } from "./onboarding-state";
test("native permission status is authoritative; undetectable ones use the manual check", () => {
  assert.equal(permissionView("granted", undefined, false), "ok");
  assert.equal(permissionView("denied", undefined, true), "warn");
  assert.equal(permissionView("unknown", "granted", false), "ok");
  assert.equal(permissionView(undefined, "denied", true), "ok");
  assert.equal(permissionView(undefined, undefined, false), "manual");
  assert.equal(permissionView(undefined, "unknown", true), "ok");
});
