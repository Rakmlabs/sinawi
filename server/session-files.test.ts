import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
