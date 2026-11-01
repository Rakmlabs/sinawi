import test from "node:test";
import assert from "node:assert/strict";
import { detectTools, parseVersion, searchPath, SETTINGS_PANES, SETUP_TOOLS } from "./setup.js";

test("versions are parsed from typical --version output", () => {
  assert.equal(parseVersion("v22.11.0"), "22.11.0");
  assert.equal(parseVersion("git version 2.39.5 (Apple Git-154)"), "2.39.5");
  assert.equal(parseVersion("2.1.314 (Claude Code)"), "2.1.314");
  assert.equal(parseVersion("grok 1.0.70 (f50904eaee6c) [stable]"), "1.0.70");
  assert.equal(parseVersion("nothing"), undefined);
});

test("missing CLIs are reported, not thrown", async () => {
  const tools = await detectTools(async (command) => { if (command === "codex" || command === "grok") throw new Error("ENOENT"); return `${command} 1.2.3`; });
  assert.deepEqual(tools.filter((t) => !t.installed).map((t) => t.id), ["codex", "grok"]);
  assert.equal(tools.find((t) => t.id === "claude")?.version, "1.2.3");
});

test("every tool has an official install command; agents have a login command", () => {
  for (const tool of SETUP_TOOLS) { assert.ok(tool.install && tool.docs.startsWith("https://")); if (tool.agent) assert.ok(tool.login); }
  assert.equal(SETUP_TOOLS.filter((t) => t.agent).length, 3);
});

test("search path adds common install dirs for the current user without duplicates", () => {
  const path = searchPath({ PATH: "/usr/bin:/opt/homebrew/bin" }, "/Users/someone");
  assert.ok(path.includes("/Users/someone/.grok/bin") && path.includes("/Users/someone/.local/bin"));
  assert.equal(path.split(":").filter((p) => p === "/usr/bin").length, 1);
});

test("settings panes are System Settings deep links only", () => {
  for (const url of Object.values(SETTINGS_PANES)) assert.match(url, /^x-apple\.systempreferences:/);
});
