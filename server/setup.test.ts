import test from "node:test";
import assert from "node:assert/strict";
import { detectTools, nodeArchShouldWarn, nodeInSupportedRange, parseVersion, searchPath, SETTINGS_PANES, SETUP_TOOLS } from "./setup.js";

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

test("supported Node.js versions pass the range check", () => {
  for (const v of ["22.23.4", "22.24.0", "22.100.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0", "28.0.0"]) {
    assert.ok(nodeInSupportedRange(v), `expected ${v} to be in range`);
  }
});

test("unsupported Node.js versions fail the range check", () => {
  for (const v of ["18.0.0", "20.0.0", "22.23.3", "22.22.0", "23.0.0", "24.21.0", "24.22.0", "25.0.0", "26.11.0", "26.12.0"]) {
    assert.ok(!nodeInSupportedRange(v), `expected ${v} to be out of range`);
  }
});

test("nodeArchShouldWarn fires only for x64 Node on Apple Silicon", () => {
  assert.ok(nodeArchShouldWarn("x64", true));
  assert.ok(!nodeArchShouldWarn("arm64", true));
  assert.ok(!nodeArchShouldWarn("x64", false));
  assert.ok(!nodeArchShouldWarn("arm64", false));
});

test("Node.js tool warns when version is outside the supported range", async () => {
  const tools = await detectTools(async (command) => {
    if (command === "node") return "v18.20.0";
    throw new Error("not found");
  });
  const node = tools.find((t) => t.id === "node");
  assert.equal(node?.installed, true);
  assert.equal(node?.warning, "unsupported-version");
});

test("Node.js tool warns when running under Rosetta on Apple Silicon (mocked)", async () => {
  const tools = await detectTools(async (command, args) => {
    if (command === "node" && args?.[0] === "--version") return "v24.22.1";
    if (command === "node" && args?.[0] === "-p") return "x64";
    if (command === "/usr/sbin/sysctl") return "1";
    if (command === "npm" || command === "git" || command === "claude" || command === "codex" || command === "grok") return `${command} 1.0.0`;
    return "";
  });
  const node = tools.find((t) => t.id === "node");
  assert.equal(node?.installed, true);
  // The rosetta warning fires only on darwin; on other platforms the sysctl path is skipped.
  if (process.platform === "darwin") {
    assert.equal(node?.warning, "rosetta");
  } else {
    assert.equal(node?.warning, undefined);
  }
});

test("Node.js tool has no warning when version is supported and arch matches", async () => {
  const tools = await detectTools(async (command, args) => {
    if (command === "node" && args?.[0] === "--version") return "v24.22.1";
    if (command === "node" && args?.[0] === "-p") return "arm64";
    if (command === "/usr/sbin/sysctl") return "1";
    if (command === "npm" || command === "git" || command === "claude" || command === "codex" || command === "grok") return `${command} 1.0.0`;
    return "";
  });
  const node = tools.find((t) => t.id === "node");
  assert.equal(node?.warning, undefined);
});
