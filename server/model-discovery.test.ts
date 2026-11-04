import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultRoutingSettings,
  discoverCliModels,
  loadRoutingSettings,
  parseGrokModels,
  RoutingService,
  saveRoutingSettings,
  type ModelCommandRunner,
} from "./routing.js";

test("Grok model output parser accepts default and ordinary catalog lines", () => {
  assert.deepEqual(parseGrokModels(`\u001b[32mAvailable models:\u001b[0m
  \u001b[1m* grok-4.7 (default)\u001b[0m
  - grok-4.7-build-fast
  - grok-4.6
noise`), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
});

test("CLI discovery replaces the Grok catalog and reports cheap auth status", async () => {
  const runner: ModelCommandRunner = async (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "grok models") return { stdout: "You are logged in with grok.com.\n* grok-4.7 (default)\n- grok-4.6\n" };
    if (invocation === "codex login status") return { stdout: "Logged in using ChatGPT\n" };
    if (invocation === "claude auth status") return { stdout: JSON.stringify({ loggedIn: false }) };
    throw new Error(`unexpected command: ${invocation}`);
  };
  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    await mkdtemp(join(tmpdir(), "orchestra-models-home-")),
    runner,
    { sleep: async () => undefined },
  );

  assert.deepEqual(settings.modelOptions.grok.models, ["grok-4.7", "grok-4.6"]);
  assert.equal(settings.modelOptions.grok.source, "cli");
  assert.equal(settings.modelOptions.grok.authStatus, "authenticated");
  assert.equal(settings.modelOptions.codex.authStatus, "authenticated");
  assert.equal(settings.modelOptions.claude.authStatus, "unauthenticated");
  assert.match(settings.modelOptions.claude.authDetail ?? "", /claude auth login/);
});

test("Grok unauthenticated output keeps editable presets and exposes the requested login message", async () => {
  const runner: ModelCommandRunner = async (command) => {
    if (command !== "grok") throw new Error("CLI unavailable");
    throw Object.assign(new Error("not logged in"), { stderr: "You are not authenticated. Please login." });
  };
  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    await mkdtemp(join(tmpdir(), "orchestra-models-home-")),
    runner,
    { sleep: async () => undefined },
  );

  assert.deepEqual(settings.modelOptions.grok.models, ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  assert.equal(settings.modelOptions.grok.authStatus, "unauthenticated");
  assert.equal(settings.modelOptions.grok.authDetail, "Grok 로그인 필요: 터미널에서 grok login");
});

test("Grok positive login output wins over stale negative diagnostics", async () => {
  const runner: ModelCommandRunner = async (command) => command === "grok"
    ? { stdout: "You are logged in with grok.com.\n", stderr: "Previous check: not logged in" }
    : { stdout: "" };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    await mkdtemp(join(tmpdir(), "orchestra-models-home-")),
    runner,
  );

  assert.equal(settings.modelOptions.grok.authStatus, "authenticated");
});

test("Claude structured login status wins over unrelated unauthenticated stderr", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  let claudeCalls = 0;
  const runner: ModelCommandRunner = async (command) => {
    if (command !== "claude") return { stdout: "" };
    claudeCalls += 1;
    return {
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "MCP server example is unauthenticated",
    };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    homeDir,
    runner,
    { sleep: async () => undefined },
  );

  assert.equal(claudeCalls, 1);
  assert.equal(settings.modelOptions.claude.authStatus, "authenticated");
});

test("Claude plain-text login status wins over unrelated unauthenticated stderr", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  let claudeCalls = 0;
  const runner: ModelCommandRunner = async (command) => {
    if (command !== "claude") return { stdout: "" };
    claudeCalls += 1;
    return { stdout: "Logged in using Claude.ai", stderr: "MCP server example is unauthenticated" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined },
  );

  assert.equal(claudeCalls, 1);
  assert.equal(settings.modelOptions.claude.authStatus, "authenticated");
});

test("Claude retry uses structured status and unavailable account probes remain unknown", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  let claudeCalls = 0;
  const runner: ModelCommandRunner = async (command, _args, options) => {
    if (command !== "claude") return { stdout: "" };
    if (options?.env?.CLAUDE_CONFIG_DIR?.endsWith("missing")) throw new Error("CLI unavailable");
    claudeCalls += 1;
    return claudeCalls === 1
      ? { stdout: JSON.stringify({ loggedIn: false }) }
      : { stdout: JSON.stringify({ loggedIn: true }), stderr: "MCP server remains unauthenticated" };
  };

  const recovered = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined }, { claude: join(homeDir, "working") },
  );
  const unavailable = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined }, { claude: join(homeDir, "missing") },
  );

  assert.equal(claudeCalls, 2);
  assert.equal(recovered.modelOptions.claude.authStatus, "authenticated");
  assert.equal(unavailable.modelOptions.claude.authStatus, "unknown");
});

test("Codex and Grok positive command output wins over unrelated unauthenticated stderr", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const calls = { codex: 0, grok: 0 };
  const runner: ModelCommandRunner = async (command) => {
    if (command === "codex") {
      calls.codex += 1;
      return { stdout: "Logged in using ChatGPT", stderr: "MCP server docs is not authenticated" };
    }
    if (command === "grok") {
      calls.grok += 1;
      return { stdout: "You are logged in with grok.com.\n* grok-4.7 (default)", stderr: "MCP server docs is not authenticated" };
    }
    return { stdout: "" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined },
  );

  assert.deepEqual(calls, { codex: 1, grok: 1 });
  assert.equal(settings.modelOptions.codex.authStatus, "authenticated");
  assert.equal(settings.modelOptions.grok.authStatus, "authenticated");
});

test("Codex and Grok explicit negative stdout remains a confirmed logout", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const calls = { codex: 0, grok: 0 };
  const runner: ModelCommandRunner = async (command) => {
    if (command === "codex") calls.codex += 1;
    if (command === "grok") calls.grok += 1;
    return command === "claude" ? { stdout: "" } : { stdout: "Not authenticated" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined },
  );

  assert.deepEqual(calls, { codex: 2, grok: 2 });
  assert.equal(settings.modelOptions.codex.authStatus, "unauthenticated");
  assert.equal(settings.modelOptions.grok.authStatus, "unauthenticated");
});

test("MCP-only unauthenticated stderr remains unknown for every CLI", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const calls = { claude: 0, codex: 0, grok: 0 };
  const runner: ModelCommandRunner = async (command) => {
    calls[command as keyof typeof calls] += 1;
    return { stdout: "", stderr: "MCP server docs is not authenticated" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined },
  );

  assert.deepEqual(calls, { claude: 1, codex: 1, grok: 1 });
  assert.equal(settings.modelOptions.claude.authStatus, "unknown");
  assert.equal(settings.modelOptions.codex.authStatus, "unknown");
  assert.equal(settings.modelOptions.grok.authStatus, "unknown");
});

test("MCP-only unauthenticated stdout remains unknown for every CLI", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const calls = { claude: 0, codex: 0, grok: 0 };
  const runner: ModelCommandRunner = async (command) => {
    calls[command as keyof typeof calls] += 1;
    return { stdout: "MCP server docs is not authenticated", stderr: "" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings), homeDir, runner, { sleep: async () => undefined },
  );

  assert.deepEqual(calls, { claude: 1, codex: 1, grok: 1 });
  assert.equal(settings.modelOptions.claude.authStatus, "unknown");
  assert.equal(settings.modelOptions.codex.authStatus, "unknown");
  assert.equal(settings.modelOptions.grok.authStatus, "unknown");
});

test("an unauthenticated status is retried once before it is reported", async () => {
  let grokCalls = 0;
  const sleeps: number[] = [];
  const runner: ModelCommandRunner = async (command) => {
    if (command !== "grok") return { stdout: "" };
    grokCalls += 1;
    return grokCalls === 1
      ? { stdout: "You are not logged in." }
      : { stdout: "You are logged in with grok.com.\n* grok-4.7 (default)\n" };
  };

  const settings = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    await mkdtemp(join(tmpdir(), "orchestra-models-home-")),
    runner,
    { sleep: async (milliseconds) => { sleeps.push(milliseconds); } },
  );

  assert.equal(grokCalls, 2);
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(settings.modelOptions.grok.authStatus, "authenticated");
});

test("saved stale Grok IDs are migrated and Claude negative auth text is not a false positive", async () => {
  const settings = structuredClone(defaultRoutingSettings);
  settings.modelOptions.grok.models = ["grok-1", "grok-code-fast-1"];
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  await mkdir(join(homeDir, ".grok"));
  await writeFile(join(homeDir, ".grok", "config.json"), JSON.stringify({ model: "grok-1-preview" }));
  const runner: ModelCommandRunner = async (command) => {
    if (command === "claude") return { stdout: "Not authenticated" };
    throw new Error("CLI unavailable");
  };
  const discovered = await discoverCliModels(settings, homeDir, runner, { sleep: async () => undefined });

  assert.deepEqual(discovered.modelOptions.grok.models, ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  assert.equal(discovered.modelOptions.claude.authStatus, "unauthenticated");
});

test("RoutingService refresh caches only discovered models while rereading rules from disk", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-models-data-"));
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  await mkdir(join(homeDir, ".codex"));
  await writeFile(join(homeDir, ".codex", "config.toml"), 'model = "configured-codex"\n');
  const settings = structuredClone(defaultRoutingSettings);
  await saveRoutingSettings(settings, dataDir);
  const modelRunner: ModelCommandRunner = async (command) => command === "grok"
    ? { stdout: "* grok-4.7 (default)\n- grok-4.5\n" }
    : { stdout: "Logged in\n" };
  const service = new RoutingService({ dataDir, homeDir, modelRunner });

  const refreshed = await service.refreshModels();
  assert.equal(refreshed.modelOptions.codex.models[0], "configured-codex");
  settings.rules[0].label = "저장 후 변경된 규칙";
  await saveRoutingSettings(settings, dataDir);
  const loaded = await service.loadSettings();
  assert.equal(loaded.rules[0].label, "저장 후 변경된 규칙");
  assert.deepEqual(loaded.modelOptions.grok.models, ["grok-4.7", "grok-4.5"]);
});

test("saving after discovery keeps runtime auth badges without persisting them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-models-save-"));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), dataDir);
  const modelRunner: ModelCommandRunner = async (command) => command === "grok"
    ? { stdout: "* grok-4.7 (default)\n" }
    : { stdout: "Logged in\n" };
  const service = new RoutingService({ dataDir, homeDir: await mkdtemp(join(tmpdir(), "orchestra-models-home-")), modelRunner });
  const refreshed = await service.refreshModels();
  const edited = structuredClone(refreshed);
  edited.modelOptions.codex.models = ["my-codex-model"];
  delete edited.modelOptions.codex.authStatus;
  delete edited.modelOptions.codex.authDetail;

  const saved = await service.saveSettings(edited);
  assert.deepEqual(saved.modelOptions.codex.models, ["my-codex-model"]);
  assert.equal(saved.modelOptions.codex.authStatus, "authenticated");
  assert.deepEqual((await service.loadSettings()).modelOptions.codex.models, ["my-codex-model"]);
  const persisted = JSON.parse(await readFile(join(dataDir, "routing-settings.json"), "utf8"));
  assert.equal(persisted.modelOptions.codex.authStatus, undefined);
  assert.equal(persisted.modelOptions.codex.authDetail, undefined);
});

test("workspace account folders drive local model and authentication discovery", async (t) => {
  const fallbackHome = await mkdtemp(join(tmpdir(), "orchestra-models-fallback-"));
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-models-data-"));
  const codexHome = await mkdtemp(join(tmpdir(), "orchestra-models-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "orchestra-models-claude-"));
  const grokHome = await mkdtemp(join(tmpdir(), "orchestra-models-grok-"));
  t.after(() => Promise.all([fallbackHome, dataDir, codexHome, claudeHome, grokHome].map((directory) => rm(directory, { recursive: true, force: true }))));
  await mkdir(join(fallbackHome, ".codex"));
  await writeFile(join(fallbackHome, ".codex", "config.toml"), 'model = "default-codex"\n');
  await writeFile(join(codexHome, "config.toml"), 'model = "workspace-codex"\n');
  await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ model: "workspace-claude" }));
  await writeFile(join(grokHome, "config.json"), JSON.stringify({ model: "workspace-grok" }));
  const environments: Array<Record<string, string> | undefined> = [];
  const runner: ModelCommandRunner = async (_command, _args, options) => {
    environments.push(options?.env);
    return { stdout: "Logged in authenticated" };
  };
  const accounts = { codex: codexHome, claude: claudeHome, grok: grokHome };

  const initial = await loadRoutingSettings(dataDir, fallbackHome, accounts);
  assert.equal(initial.modelOptions.codex.models.includes("default-codex"), false);
  assert.equal(initial.modelOptions.codex.models[0], "workspace-codex");

  const discovered = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    fallbackHome,
    runner,
    { sleep: async () => undefined },
    accounts,
  );

  assert.equal(discovered.modelOptions.codex.models[0], "workspace-codex");
  assert.equal(discovered.modelOptions.claude.models[0], "workspace-claude");
  assert.equal(discovered.modelOptions.grok.models[0], "workspace-grok");
  assert.deepEqual(environments, [
    { GROK_HOME: grokHome },
    { CODEX_HOME: codexHome },
    { CLAUDE_CONFIG_DIR: claudeHome },
  ]);
});

test("default CLI accounts are probed without forcing their conventional config directories", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-default-account-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const environments = new Map<string, Record<string, string> | undefined>();
  const runner: ModelCommandRunner = async (command, _args, options) => {
    environments.set(command, options?.env);
    return command === "claude" && options?.env?.CLAUDE_CONFIG_DIR
      ? { stdout: JSON.stringify({ loggedIn: false }) }
      : { stdout: command === "claude" ? JSON.stringify({ loggedIn: true }) : "Logged in authenticated" };
  };

  const discovered = await discoverCliModels(
    structuredClone(defaultRoutingSettings),
    homeDir,
    runner,
    { sleep: async () => undefined },
  );

  assert.deepEqual(environments.get("claude"), {});
  assert.equal(discovered.modelOptions.claude.authStatus, "authenticated");
});

test("RoutingService caches authentication separately for each workspace account", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-models-account-cache-"));
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-home-"));
  const firstCodex = await mkdtemp(join(tmpdir(), "orchestra-models-codex-a-"));
  const secondCodex = await mkdtemp(join(tmpdir(), "orchestra-models-codex-b-"));
  t.after(() => Promise.all([dataDir, homeDir, firstCodex, secondCodex].map((directory) => rm(directory, { recursive: true, force: true }))));
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), dataDir);
  const modelRunner: ModelCommandRunner = async (command, _args, options) => {
    if (command !== "codex") return { stdout: "Logged in authenticated" };
    return { stdout: options?.env?.CODEX_HOME === firstCodex ? "Logged in authenticated" : "Not authenticated" };
  };
  const service = new RoutingService({ dataDir, homeDir, modelRunner, authDiscovery: { sleep: async () => undefined } });

  await service.refreshModels({ codex: firstCodex });
  await service.refreshModels({ codex: secondCodex });

  assert.equal((await service.loadSettings({ codex: firstCodex })).modelOptions.codex.authStatus, "authenticated");
  assert.equal((await service.loadSettings({ codex: secondCodex })).modelOptions.codex.authStatus, "unauthenticated");
});

test("inherited CLI account roots drive model discovery and cache identity", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "orchestra-models-inherited-data-"));
  const homeDir = await mkdtemp(join(tmpdir(), "orchestra-models-inherited-home-"));
  const firstCodex = await mkdtemp(join(tmpdir(), "orchestra-models-inherited-a-"));
  const secondCodex = await mkdtemp(join(tmpdir(), "orchestra-models-inherited-b-"));
  const previous = process.env.CODEX_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await Promise.all([dataDir, homeDir, firstCodex, secondCodex].map((directory) => rm(directory, { recursive: true, force: true })));
  });
  await writeFile(join(firstCodex, "config.toml"), 'model = "inherited-first"\n');
  await writeFile(join(secondCodex, "config.toml"), 'model = "inherited-second"\n');
  await saveRoutingSettings(structuredClone(defaultRoutingSettings), dataDir);
  const modelRunner: ModelCommandRunner = async (command, _args, options) => command === "codex"
    ? { stdout: options?.env?.CODEX_HOME === firstCodex ? "Logged in authenticated" : "Not authenticated" }
    : { stdout: "Logged in authenticated" };
  const service = new RoutingService({ dataDir, homeDir, modelRunner, authDiscovery: { sleep: async () => undefined } });

  process.env.CODEX_HOME = firstCodex;
  const first = await service.refreshModels();
  assert.equal(first.modelOptions.codex.models[0], "inherited-first");
  process.env.CODEX_HOME = secondCodex;
  const second = await service.refreshModels();
  assert.equal(second.modelOptions.codex.models[0], "inherited-second");
  process.env.CODEX_HOME = firstCodex;
  assert.equal((await service.loadSettings()).modelOptions.codex.authStatus, "authenticated");
});
