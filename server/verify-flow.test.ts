import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildInvocation, type RunCliOptions } from "./cli.js";
import { Orchestra } from "./orchestra.js";
import type { Session } from "./types.js";
import { repoSnapshot } from "./worktrees.js";

async function settle(session: Session) {
  const start = Date.now();
  while (session.status === "running") {
    if (Date.now() - start > 2_000) throw new Error("run did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const delegate = '<<DELEGATE to="claude">>main을 되돌린다<</DELEGATE>>';

test("a worker report that says 상태: 완료 is the answer: no review run", async () => {
  const roles: string[] = [];
  const runner = async (options: RunCliOptions) => {
    roles.push(`${options.usageContext?.role}${options.readOnly ? ":ro" : ""}`);
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 완료\n\n`bc73878`을 main에 올렸습니다." };
    return { exitCode: 0, finalText: delegate };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "롤백", agent: "grok", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "done");
  assert.deepEqual(roles, ["orchestrator", "worker"], "no read-only review after a clean report");
  const answer = session.events.find((event) => event.metadata?.phase === "worker-report");
  assert.match(answer?.text ?? "", /^상태: 완료/);
});

test("partial or blocked reports still go to the lead, with the original request", async () => {
  const prompts: RunCliOptions[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push(options);
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 부분 완료\n테스트를 못 돌렸습니다." };
    return { exitCode: 0, finalText: prompts.length === 1 ? delegate : "최종" };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "기존꺼로 롤백해줘", agent: "grok", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  const review = prompts.find((call) => call.readOnly);
  assert.ok(review, "the lead reviews a partial report");
  assert.match(review.prompt, /원래 사용자 요청:\n기존꺼로 롤백해줘/);
});

test("a lead that gives up on a blocked worker ends the run as an error, not 완료", async () => {
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 막힘\n개발 서버가 뜨지 않습니다." };
    return { exitCode: 0, finalText: options.readOnly ? "다시 맡겨도 같은 곳에서 막힙니다." : delegate };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "UI 점검", agent: "claude", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "error");
  assert.ok(!session.events.some((event) => event.text === "세션이 완료되었습니다."));
  assert.match(session.events.at(-1)?.text ?? "", /작업은 끝나지 않았습니다/);
});

test("a review the CLI cancels hands over the worker reports instead of ending silently", async () => {
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 막힘\npush가 거부됐습니다." };
    if (options.readOnly) {
      options.onLine({ type: "error", text: "Grok Build가 중단되었습니다 (cancelled)." });
      return { exitCode: 0, finalText: "" };
    }
    return { exitCode: 0, finalText: delegate };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "배포", agent: "grok", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  assert.ok(session.events.some((event) => event.metadata?.phase === "verify-cut"));
  assert.match(session.events.find((event) => event.metadata?.phase === "worker-report")?.text ?? "", /push가 거부됐습니다/);
});

test("the review gets git facts from the app, and Grok's read-only runs lose MCP tools", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sinawi-snap-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first commit");
  const snapshot = await repoSnapshot(base);
  assert.match(snapshot, /## main/);
  assert.match(snapshot, /first commit/);
  assert.equal(await repoSnapshot(tmpdir()), "");
  for (const readTools of [true, false]) {
    const args = buildInvocation({ agent: "grok", prompt: "x", cwd: base, readOnly: true, readTools }).args;
    assert.equal(args[args.indexOf("--disallowed-tools") + 1], "search_tool,use_tool");
  }
});

test("a worker the app cut off is the lead's call: a lead that verifies the work ends the run as done", async () => {
  const runner = async (options: RunCliOptions) => {
    if (options.usageContext?.role === "worker") {
      options.onLine({ type: "error", text: "Claude Code가 중단되었습니다 (cancelled)." });
      return { exitCode: 0, finalText: "버튼 색을 바꾸고 테스트를 통과시켰습니다." };
    }
    return { exitCode: 0, finalText: options.readOnly ? "결과: 변경이 git에 있고 테스트 출력도 남아 있습니다. 발견 없음." : delegate };
  };
  const orchestra = new Orchestra(undefined, runner);
  const session = await orchestra.create({ prompt: "UI 점검", agent: "claude", workers: ["claude"], cwd: process.cwd() });
  await settle(session);
  assert.equal(session.status, "done");
});
