import test from "node:test";
import assert from "node:assert/strict";
import { environmentLoginCommand, environmentSettingsPath } from "./onboarding-state";
import type { SetupTool } from "../server/setup";

const codex: SetupTool = { id: "codex", name: "Codex CLI", agent: true, installed: true, install: "npm install", docs: "https://example.com", login: "codex login" };

test("environment auth settings are read from the selected workspace", () => {
  assert.equal(environmentSettingsPath("client work"), "/api/settings?workspace=client%20work");
});

test("environment login uses the workspace account directory", () => {
  assert.equal(environmentLoginCommand(codex, { codex: "/accounts/client codex" }), "mkdir -p '/accounts/client codex' && CODEX_HOME='/accounts/client codex' codex login");
  assert.equal(environmentLoginCommand(codex, {}), "codex login");
});
