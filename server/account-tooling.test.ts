import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installAccountSkills } from "./account-tooling.js";
import { discoverMcpTools, updateMcpTool } from "./tools.js";

test("account skills install both app skills directly into each CLI account", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-skills-"));
  try {
    const accounts = { claude: join(root, "claude"), codex: join(root, "codex"), grok: join(root, "grok") };
    await installAccountSkills(accounts);
    for (const account of Object.values(accounts)) for (const name of ["orchestra-browser", "orchestra-computer"]) {
      assert.match(await readFile(join(account, "skills", name, "SKILL.md"), "utf8"), new RegExp(`name: ${name}`));
    }
    await installAccountSkills(accounts);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP discovery and edits use account env and the account Codex config", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-mcp-"));
  try {
    const accounts = { codex: join(root, "codex"), grok: join(root, "grok"), claude: join(root, "claude") };
    await mkdir(accounts.codex);
    const file = join(accounts.codex, "config.toml");
    await writeFile(file, "[mcp_servers.docs]\nenabled = true\n");
    const calls: Array<{ agent: string; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (agent: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ agent, env: options?.env });
      return { stdout: agent === "codex" ? "Name  Url                   Bearer Token Env Var  Status   Auth\ndocs  https://example.test  -                     enabled  Not logged in\n" : "docs: https://example.test - Needs authentication\n" };
    };
    const tools = await discoverMcpTools("work", { runner, policy: { mediaGeneration: true, computerUse: false, grokMcp: true, blockedTools: [], authAlertTools: [], accounts } });
    assert.equal(calls.find((call) => call.agent === "codex")?.env?.CODEX_HOME, accounts.codex);
    assert.equal(calls.find((call) => call.agent === "claude")?.env?.CLAUDE_CONFIG_DIR, accounts.claude);
    assert.match(tools.find((tool) => tool.agent === "codex")?.authCommand ?? "", /CODEX_HOME=/);
    await updateMcpTool({ agent: "codex", name: "docs", enabled: false }, { runner, accounts });
    assert.match(await readFile(file, "utf8"), /enabled = false/);
    await updateMcpTool({ agent: "grok", name: "docs", enabled: false }, { runner, accounts });
    assert.equal(calls.at(-1)?.env?.GROK_HOME, accounts.grok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent Codex MCP edits preserve every requested change", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-mcp-concurrent-"));
  const config = join(root, "config.toml");
  try {
    await writeFile(config, "[mcp_servers.docs]\nenabled = true\n\n[mcp_servers.search]\nenabled = true\n");

    await Promise.all([
      updateMcpTool({ agent: "codex", name: "docs", enabled: false }, { codexConfigPath: config }),
      updateMcpTool({ agent: "codex", name: "search", enabled: false }, { codexConfigPath: config }),
    ]);

    const updated = await readFile(config, "utf8");
    assert.match(updated, /\[mcp_servers\.docs\][\s\S]*?enabled = false/);
    assert.match(updated, /\[mcp_servers\.search\][\s\S]*?enabled = false/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
