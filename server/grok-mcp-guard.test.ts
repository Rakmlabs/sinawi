import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { ensureCompanyGrokGuard } from "./grok-mcp-guard.js";

test("creates the company Grok guard at the git root and excludes it locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-guard-"));
  const nested = join(root, "packages", "app");
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await mkdir(nested, { recursive: true });

  await ensureCompanyGrokGuard(nested);

  assert.equal(await readFile(join(root, ".grok", "config.toml"), "utf8"),
    '[mcp_servers.bbanana]\nurl = "https://www.bbanana.ai/mcp"\nenabled = false\n');
  assert.equal(await readFile(join(root, ".git", "info", "exclude"), "utf8"), ".grok/\n");
});

test("rewrites only the bbanana table and preserves other Grok project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-guard-"));
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await mkdir(join(root, ".grok"));
  await writeFile(join(root, ".grok", "config.toml"), [
    'model = "grok-4.7"',
    "",
    "[mcp_servers.bbanana]",
    'url = "https://old.invalid/mcp"',
    "enabled = true",
    "custom = 1",
    "",
    "[mcp_servers.other]",
    'url = "https://other.invalid/mcp"',
    "enabled = true",
    "",
  ].join("\n"));
  await writeFile(join(root, ".git", "info", "exclude"), "dist/\n.grok/\n");

  await ensureCompanyGrokGuard(root);
  await ensureCompanyGrokGuard(root);

  const config = await readFile(join(root, ".grok", "config.toml"), "utf8");
  assert.match(config, /model = "grok-4\.7"/);
  assert.match(config, /\[mcp_servers\.bbanana\]\nurl = "https:\/\/www\.bbanana\.ai\/mcp"\nenabled = false/);
  assert.doesNotMatch(config, /old\.invalid|custom = 1|enabled = true\n\n\[mcp_servers\.other\]/);
  assert.match(config, /\[mcp_servers\.other\]\nurl = "https:\/\/other\.invalid\/mcp"\nenabled = true/);
  assert.equal((await readFile(join(root, ".git", "info", "exclude"), "utf8")).match(/\.grok\//g)?.length, 1);
});

test("uses cwd outside a git repository and does not create git metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grok-guard-no-git-"));

  await ensureCompanyGrokGuard(cwd);

  assert.match(await readFile(join(cwd, ".grok", "config.toml"), "utf8"), /enabled = false/);
  await assert.rejects(readFile(join(cwd, ".git", "info", "exclude"), "utf8"), { code: "ENOENT" });
});

test("recognizes quoted bbanana table keys and preserves bytes around the replaced table", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-guard-quoted-"));
  await mkdir(join(root, ".grok"));
  const prefix = 'model = "grok-4.7"\n\n';
  const suffix = "# settings for the next server stay here\n\n[mcp_servers.other]\nenabled = true\n";
  await writeFile(join(root, ".grok", "config.toml"), prefix + [
    '[mcp_servers."bbanana"]',
    "enabled = true",
    "custom = 1",
    suffix,
  ].join("\n"));

  await ensureCompanyGrokGuard(root);

  assert.equal(await readFile(join(root, ".grok", "config.toml"), "utf8"),
    prefix + '[mcp_servers.bbanana]\nurl = "https://www.bbanana.ai/mcp"\nenabled = false\n' + suffix);
});

test("preserves every existing byte when appending and resolves relative cwd paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-guard-relative-"));
  const nested = join(root, "nested");
  await mkdir(nested);
  const existing = 'model = "grok-4.7"\n# trailing comment\n  ';
  await mkdir(join(nested, ".grok"));
  await writeFile(join(nested, ".grok", "config.toml"), existing);

  await ensureCompanyGrokGuard(relative(process.cwd(), nested));

  assert.equal(await readFile(join(nested, ".grok", "config.toml"), "utf8"),
    existing + '\n\n[mcp_servers.bbanana]\nurl = "https://www.bbanana.ai/mcp"\nenabled = false\n');
});

test("preserves comments following an otherwise empty bbanana table", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-guard-empty-table-"));
  await mkdir(join(root, ".grok"));
  const suffix = "# retained separator comment\n\n[mcp_servers.other]\nenabled = true\n";
  await writeFile(join(root, ".grok", "config.toml"), "[mcp_servers.bbanana]\n" + suffix);

  await ensureCompanyGrokGuard(root);

  assert.equal(await readFile(join(root, ".grok", "config.toml"), "utf8"),
    '[mcp_servers.bbanana]\nurl = "https://www.bbanana.ai/mcp"\nenabled = false\n' + suffix);
});
