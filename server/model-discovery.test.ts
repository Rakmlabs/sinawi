import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultRoutingSettings,
  discoverCliModels,
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
