import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { existingEvidence, VerifyEvidenceGuard } from "./verify-evidence.js";

test("VerifyEvidenceGuard leaves ordinary implementation retries to the goal and stall guards", async () => {
  const guard = new VerifyEvidenceGuard();
  for (const brief of ["A", "코드를 확인하고 버그를 수정한다", "Check the code and fix the bug", "package.json 확인 후 버그 수정"]) {
    for (let i = 0; i < 4; i++) await guard.check(brief, process.cwd(), []);
  }
});

test("existingEvidence resolves local evidence across session roots and removes duplicates", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-evidence-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "session");
  const worktree = join(base, "worktree");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(worktree, "docs"), { recursive: true });
  const screenshot = join(worktree, "docs", "screen.png");
  const report = join(cwd, "report.md");
  await writeFile(screenshot, "image");
  await writeFile(report, "report");

  const files = await existingEvidence(
    `![screen](docs/screen.png) duplicate: docs/screen.png\n${report}\nhttps://example.invalid/remote.png missing.json`,
    cwd,
    [worktree],
  );

  assert.deepEqual(files, [await realpath(screenshot), await realpath(report)].sort());
});

test("VerifyEvidenceGuard normalizes whitespace before counting repeated briefs", async () => {
  const guard = new VerifyEvidenceGuard();
  await guard.check("기존 스크린샷 증거를 검증한다", process.cwd(), []);
  await guard.check("  기존   스크린샷 증거를\n검증한다  ", process.cwd(), []);

  await assert.rejects(
    guard.check("기존 스크린샷 증거를 검증한다", process.cwd(), []),
    /같은 증거 검증을 2회 반복/u,
  );
});

test("VerifyEvidenceGuard stops reworded screenshot briefs that reuse the same file", async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "sinawi-screenshot-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const screenshot = join(cwd, "evidence.png");
  await writeFile(screenshot, "image");
  const guard = new VerifyEvidenceGuard();

  await guard.check("첫 화면 스크린샷 확인: evidence.png", cwd, []);
  await guard.check("다른 관점으로 스크린샷 재검토: evidence.png", cwd, []);

  await assert.rejects(
    guard.check("마지막으로 스크린샷을 다시 본다: evidence.png", cwd, []),
    (error: unknown) => error instanceof Error
      && /같은 증거 검증을 2회 반복/u.test(error.message)
      && error.message.includes(screenshot),
  );
});
