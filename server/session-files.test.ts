import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionImage } from "./session-files";

test("session images resolve inside the work folder only", async () => {
  const base = mkdtempSync(join(tmpdir(), "ao-img-"));
  const cwd = join(base, "site"); mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs/a.png"), "x"); writeFileSync(join(base, "secret.png"), "x"); writeFileSync(join(cwd, "notes.txt"), "x");
  symlinkSync(join(base, "secret.png"), join(cwd, "link.png"));
  assert.match((await resolveSessionImage(cwd, "docs/a.png")).file, /docs\/a\.png$/);
  assert.match((await resolveSessionImage(cwd, join(cwd, "docs/a.png"))).type, /png/);
  await assert.rejects(resolveSessionImage(cwd, "../secret.png"), /밖/);
  await assert.rejects(resolveSessionImage(cwd, join(base, "secret.png")), /밖/);
  await assert.rejects(resolveSessionImage(cwd, "link.png"), /밖/);
  await assert.rejects(resolveSessionImage(cwd, "notes.txt"), /이미지/);
  assert.ok(await resolveSessionImage(cwd, join(base, "secret.png"), [base]));
});

test("relative session images fall back to a listed worktree", async () => {
  const base = mkdtempSync(join(tmpdir(), "ao-img-worktree-"));
  const cwd = join(base, "site");
  const worktree = join(base, "worktree");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(worktree, "docs/design"), { recursive: true });
  writeFileSync(join(worktree, "docs/design/detail.png"), "x");

  const resolved = await resolveSessionImage(cwd, "docs/design/detail.png", [worktree]);

  assert.equal(resolved.file, realpathSync(join(worktree, "docs/design/detail.png")));
});

test("relative session image paths cannot escape into an extra root", async () => {
  const base = mkdtempSync(join(tmpdir(), "ao-img-escape-"));
  const cwd = join(base, "site");
  const worktree = join(base, "worktree");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(base, "secret.png"), "x");

  await assert.rejects(resolveSessionImage(cwd, "../secret.png", [base, worktree]), /밖/);
});

test("absolute browser queue images resolve when the queue is listed", async () => {
  const base = mkdtempSync(join(tmpdir(), "ao-img-browser-"));
  const cwd = join(base, "site");
  const queueDir = join(base, "sinawi-browser");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(queueDir, { recursive: true });
  const screenshot = join(queueDir, "shot.png");
  writeFileSync(screenshot, "x");

  assert.equal((await resolveSessionImage(cwd, screenshot, [queueDir])).file, realpathSync(screenshot));
});

test("download copies into the downloads folder without overwriting", async () => {
  const { copyToDownloads } = await import("./session-files.js");
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  const file = join(dir, "shot.png");
  await writeFile(file, "x");
  const first = await copyToDownloads(file, join(dir, "Downloads"));
  const second = await copyToDownloads(file, join(dir, "Downloads"));
  assert.equal(first, join(dir, "Downloads", "shot.png"));
  assert.equal(second, join(dir, "Downloads", "shot (1).png"));
  assert.equal(await readFile(second, "utf8"), "x");
});
