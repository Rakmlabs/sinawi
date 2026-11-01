import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownCliDirs, resolveCli, searchDirs } from "./cli-path";

test("resolveCli finds executables without spawning and ignores non-executables", () => {
  const dir = mkdtempSync(join(tmpdir(), "ao-cli-"));
  writeFileSync(join(dir, "codex"), "#!/bin/sh\n"); chmodSync(join(dir, "codex"), 0o755);
  writeFileSync(join(dir, "claude"), "x");
  assert.equal(resolveCli("codex", [dir]), join(dir, "codex"));
  assert.equal(resolveCli("claude", [dir]), undefined);
  assert.equal(resolveCli(join(dir, "codex")), join(dir, "codex"));
});

test("search dirs merge PATH, login PATH and generic install locations", () => {
  const home = "/home/u";
  const dirs = searchDirs({ PATH: "/a:~/b" }, home, ["/c"]);
  assert.deepEqual(dirs.slice(0, 3), ["/a", "/home/u/b", "/c"]);
  for (const d of ["/home/u/.local/bin", "/home/u/.grok/bin", "/opt/homebrew/bin", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"]) assert.ok(dirs.includes(d), d);
  assert.ok(knownCliDirs(home).every((d) => !d.includes("1rrock")));
});
