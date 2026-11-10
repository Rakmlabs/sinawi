import test from "node:test";
import assert from "node:assert/strict";
import { cliChildEnv, cliNotes, compactHandoff, DEVELOPMENT_SHELL_PROGRAMS, ensureBrief, failureSignature, isPureNoise, missingBriefSections, ORCHESTRATOR_RULES, retargetCliNotes, reviewPrompt, StallDetector, stripToolNoise, WORKER_RULES, commandFamily, unwrapShell } from "./supervision.js";
import { BrowserBridge } from "./browser-bridge.js";
import { Orchestra } from "./orchestra.js";
import type { RunCliOptions } from "./cli.js";

const warn = "(node:14572) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.\n(Use `node --trace-warnings ...` to show where the warning was created)";

test("NO_COLOR/FORCE_COLOR warning is stripped and env never carries both", () => {
  assert.equal(isPureNoise(`결과: ${warn}`), true);
  assert.equal(stripToolNoise(`결과: ${warn}\nhello`), "결과: hello");
  const env = cliChildEnv({ FORCE_COLOR: "1", NO_COLOR: "1", HOME: "/h" }, { CI: "1" });
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.CI, "1");
  assert.equal(env.LANG, "en_US.UTF-8", "launchd gives no locale; tools need UTF-8");
  assert.equal(cliChildEnv({ LANG: "ko_KR.UTF-8" }).LANG, "ko_KR.UTF-8");
  assert.equal(cliChildEnv({ LC_ALL: "C" }).LANG, undefined);
});

test("shared prompts keep the six-field brief and add read, verify, and replan rules", () => {
  assert.match(ORCHESTRATOR_RULES, /## 목표 \/ ## 맥락 \/ ## 완료 기준 \/ ## 제약 \/ ## 검증 \/ ## 보고 형식/);
  assert.match(ORCHESTRATOR_RULES, /직접 하지 않습니다/);
  assert.match(ORCHESTRATOR_RULES, /AGENTS\.md, CLAUDE\.md, GEMINI\.md/);
  assert.match(WORKER_RULES, /편집하기 전에 대상 파일을 읽는다/);
  assert.match(WORKER_RULES, /ao-browser snapshot/);
  assert.match(WORKER_RULES, /부분 완료/);
  assert.match(ORCHESTRATOR_RULES, /## 이 앱에서 일하기/);
  assert.match(WORKER_RULES, /## 이 앱에서 일하기/);
  assert.match(ORCHESTRATOR_RULES, /이미 띄워 둔 다른 서버의 포트/);
  assert.match(ORCHESTRATOR_RULES, /\/design.*disable-model-invocation/);
  assert.match(ORCHESTRATOR_RULES, /추천해 선택받은 로컬 디자인 스킬/);
  assert.match(ORCHESTRATOR_RULES, /재위임.*실패.*하지 않는다/);
  assert.match(WORKER_RULES, /orchestra-attachments/);
  assert.match(WORKER_RULES, /\/design.*Skill 도구.*호출하지 않는다/);
  assert.match(WORKER_RULES, /HTML.*목업/);
  assert.match(WORKER_RULES, /앱 창이 열려 있지 않습니다/);
  assert.match(WORKER_RULES, /python3 -m http\.server 8765/);
  assert.match(reviewPrompt(["done"], "", 1), /ao-browser snapshot 또는 screenshot/);
  assert.doesNotMatch(cliNotes("codex", "worker"), /이 앱에서 일하기/);
  assert.doesNotMatch(cliNotes("grok", "orchestrator"), /앱 브라우저 \(ao-browser\)/);
  const review = reviewPrompt(["[worker 결과]\n상태: 완료"], "\n\n원래 사용자 요청:\n버튼", 2);
  assert.match(review, /위임한 워커들의 결과입니다/);
  assert.match(review, /검증자로서 확인/);
  assert.match(review, /틀렸을 수 있는 가정/);
  assert.match(review, /6개 제목/);
  assert.match(review, /남은 재위임 기회: 2회/);
  assert.match(reviewPrompt(["done"], "", 0), /추가 위임은 하지 마세요/);
  assert.match(review, /\[P0\]/);
  assert.match(review, /이번 워커 변경/);
  assert.match(review, /기존에 있던 버그/);
  assert.match(review, /발견 없음/);
  assert.match(cliNotes("codex", "worker"), /apply_patch/);
  assert.match(cliNotes("claude", "worker"), /요청한 것만/);
  assert.match(cliNotes("grok", "orchestrator"), /재위임/);
  assert.doesNotMatch(cliNotes("grok", "worker"), /\/Users\//);
});

test("compact handoff keeps progress, decisions, remaining work, and the next step bounded", () => {
  const summary = compactHandoff([
    { agent: "user", type: "message", text: "버튼을 고쳐줘" },
    { agent: "claude", type: "delegation", role: "worker", workerId: "codex-1", delegationId: "d1", taskStatus: "running", text: "제약: 기존 버그는 건드리지 말고 버튼만 수정" },
    { agent: "codex", type: "status", role: "worker", workerId: "codex-1", delegationId: "d1", taskStatus: "done", text: "작업을 완료했습니다." },
    { agent: "claude", type: "delegation", role: "worker", workerId: "codex-1", delegationId: "d2", taskStatus: "running", text: "남은 일: 테스트 추가" },
    { agent: "user", type: "message", text: "이어서 테스트까지" },
  ]);
  assert.match(summary, /## 진행/);
  assert.match(summary, /## 결정·제약/);
  assert.match(summary, /제약: 기존 버그/);
  assert.match(summary, /## 남은 일/);
  assert.match(summary, /테스트 추가/);
  assert.match(summary, /## 다음 단계/);
  assert.match(summary, /이어서 테스트까지/);
  assert.ok(summary.length <= 2_000);
  const flooded = compactHandoff(Array.from({ length: 40 }, (_, index) => ({
    agent: "user", type: "message", text: `결정 ${"가".repeat(300)} ${index}`,
  })));
  assert.ok(flooded.length <= 2_000);
  const otherWorker = compactHandoff([
    { agent: "user", type: "message", text: "공통 요청" },
    { agent: "codex", type: "status", role: "worker", workerId: "other", text: "다른 워커 로그" },
    { agent: "codex", type: "status", role: "worker", workerId: "mine", text: "내 진행" },
  ], "mine");
  assert.match(otherWorker, /내 진행/);
  assert.doesNotMatch(otherWorker, /다른 워커 로그/);
});

test("cli notes follow the harness and do not leak across CLIs", () => {
  const codexLead = cliNotes("codex", "orchestrator");
  const codexWorker = cliNotes("codex", "worker");
  const claudeLead = cliNotes("claude", "orchestrator");
  const claudeWorker = cliNotes("claude", "worker");
  const grokLead = cliNotes("grok", "orchestrator");
  const grokWorker = cliNotes("grok", "worker");

  assert.match(codexLead, /update_plan/);
  assert.match(codexLead, /AGENTS\.md/);
  assert.match(codexLead, /AGENTS\.override\.md/);
  assert.match(codexLead, /in_progress/);
  assert.match(codexWorker, /apply_patch/);
  assert.match(codexWorker, /applypatch/);
  assert.match(codexWorker, /3불릿/);
  assert.match(codexWorker, /git reset --hard/);
  assert.doesNotMatch(codexWorker, /TodoWrite|허용된 프로그램/);
  assert.doesNotMatch(codexLead, /Claude 총괄|Grok 총괄/);

  assert.match(claudeLead, /CLAUDE\.md/);
  assert.match(claudeLead, /포크 서브에이전트/);
  assert.match(claudeLead, /발견 없음/);
  assert.match(claudeLead, /Read/);
  assert.match(claudeWorker, /TodoWrite/);
  assert.match(claudeWorker, /TaskCreate/);
  assert.match(claudeWorker, /CLAUDE_CODE_ENABLE_TODO_TOOLS/);
  assert.match(claudeWorker, /요청한 것만/);
  assert.match(claudeWorker, /번호 목록/);
  assert.doesNotMatch(claudeWorker, /apply_patch|허용된 프로그램/);
  assert.doesNotMatch(claudeLead, /Codex 총괄|Grok 총괄/);

  assert.match(grokLead, /재위임/);
  assert.match(grokLead, /허용된 프로그램 하나/);
  assert.match(grokLead, /bash -c/);
  assert.match(grokWorker, /실행 전체를 취소/);
  assert.match(grokWorker, /명령 하나/);
  assert.match(grokWorker, /즉시 막힘/);
  assert.match(grokWorker, /상태, 한 일, 증거, 남은 문제/);
  for (const program of DEVELOPMENT_SHELL_PROGRAMS) assert.match(grokWorker, new RegExp(`\\b${program}\\b`));
  assert.doesNotMatch(grokWorker, /apply_patch|TodoWrite|\/Users\//);
  assert.doesNotMatch(grokLead, /Codex 총괄|Claude 총괄/);

  const handed = `앞말\n${cliNotes("grok", "worker")}\n뒤 로그`;
  const swapped = retargetCliNotes(handed, "grok", "codex", "worker");
  assert.match(swapped, /Codex 작업자/);
  assert.match(swapped, /apply_patch/);
  assert.doesNotMatch(swapped, /Grok 작업자|허용된 프로그램/);
  assert.match(swapped, /^앞말\n/u);
  assert.match(swapped, /뒤 로그$/u);
  assert.equal(retargetCliNotes(handed, "grok", "grok", "worker"), handed);
  assert.equal(retargetCliNotes("계획만", "claude", "grok", "orchestrator"), "계획만");
});

test("a mixed team gets each CLI's notes on its own prompt", async () => {
  const prompts: { agent: string; role?: string; prompt: string }[] = [];
  const runner = async (options: RunCliOptions) => {
    prompts.push({ agent: options.agent, role: options.usageContext?.role, prompt: options.prompt });
    if (options.usageContext?.role === "worker") return { exitCode: 0, finalText: "상태: 완료\n증거: ok" };
    if (options.prompt.includes("위임한 워커들의 결과")) return { exitCode: 0, finalText: "검증 완료" };
    return { exitCode: 0, finalText: '<<DELEGATE to="claude">>## 목표\n버튼<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner as never);
  const session = await orchestra.create({ prompt: "버튼", agent: "codex", workers: ["claude"], cwd: process.cwd() });
  for (let i = 0; i < 200 && session.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.status, "done");
  const lead = prompts.find((item) => item.role === "orchestrator")!;
  const worker = prompts.find((item) => item.role === "worker")!;
  assert.equal(lead.agent, "codex");
  assert.match(lead.prompt, /Codex 총괄/);
  assert.match(lead.prompt, /update_plan/);
  assert.match(lead.prompt, /이 앱에서 일하기/);
  assert.match(lead.prompt, /ao-browser goto/);
  assert.doesNotMatch(lead.prompt, /Claude 총괄|Grok 총괄/);
  assert.equal(worker.agent, "claude");
  assert.match(worker.prompt, /Claude 작업자/);
  assert.match(worker.prompt, /TodoWrite/);
  assert.match(worker.prompt, /## 목표/);
  assert.match(worker.prompt, /앱 창이 열려 있지 않습니다/);
  assert.doesNotMatch(worker.prompt, /Codex 작업자|Grok 작업자/);
});

test("briefs missing sections are auto-filled; complete briefs untouched", () => {
  const full = "## 목표\na\n## 맥락\nb\n## 완료 기준\nc\n## 제약\nd\n## 검증\ne\n## 보고 형식\nf";
  assert.deepEqual(missingBriefSections(full), []);
  assert.equal(ensureBrief(full, "").text, full);
  const withWords = ensureBrief(full, "레퍼런스 찾아보고 스킬 잘 써서 해줘").text;
  assert.ok(withWords.startsWith(full.trim()));
  assert.match(withWords, /## 사용자 원문 \(앱이 붙임\)\n[\s\S]*레퍼런스 찾아보고 스킬 잘 써서 해줘$/);
  assert.match(withWords, /저장소를 따르고/);
  assert.equal(ensureBrief(`${full}\n레퍼런스 찾아보고`, "레퍼런스 찾아보고").text, `${full}\n레퍼런스 찾아보고`, "already quoted: not repeated");
  const filled = ensureBrief("버튼 색을 바꿔라", "원래 요청 X");
  assert.equal(filled.missing.length, 6);
  assert.match(filled.text, /## 완료 기준 \(자동 보완\)/);
  assert.equal(filled.text.match(/원래 요청 X/g)?.length, 1, "the user's words appear once");
  assert.match(filled.text, /## 사용자 원문/);
  assert.match(filled.text, /AGENTS\.md, CLAUDE\.md, GEMINI\.md/);
});

test("different selectors with the same not-found error trip the detector at 3", () => {
  const detector = new StallDetector();
  assert.equal(failureSignature("결과: 요소를 찾을 수 없습니다: '#top video'"), failureSignature("결과: 요소를 찾을 수 없습니다: '#a[data-x=\"1\"]'"));
  assert.equal(detector.observe({ type: "tool", text: "결과: 요소를 찾을 수 없습니다: '#a'" }), undefined);
  detector.observe({ type: "tool", text: `결과: ${warn}` });
  assert.equal(detector.observe({ type: "tool", text: "결과: 요소를 찾을 수 없습니다: '#b'" }), undefined);
  const fired = detector.observe({ type: "tool", text: "결과: 요소를 찾을 수 없습니다: '#c'" });
  assert.equal(fired?.kind, "repeated-error");
});

test("echoed duplicates count once and label-only prefixes keep the message", () => {
  const detector = new StallDetector();
  const line = { type: "tool", text: "결과: 오류: 앱 창이 열려 있지 않습니다." };
  detector.observe(line); detector.observe(line);
  assert.equal(detector.observe({ type: "tool", text: "명령: ao-browser status" }), undefined);
  assert.notEqual(failureSignature("결과: 오류: 앱 창이 없습니다"), failureSignature("결과: 오류: 파일이 없습니다"));
});

test("a repeated command is a loop only when what runs between the repeats repeats too", () => {
  const shoot = (detector: StallDetector, page: string) => {
    detector.observe({ type: "tool", text: `명령: ao-browser goto ${page}` });
    return detector.observe({ type: "tool", text: "명령: ao-browser screenshot" });
  };
  const tour = new StallDetector();
  for (const page of ["#contents", "#content", "#places", "#closed", "#stats", "#public"]) assert.equal(shoot(tour, page), undefined, page);

  const stuck = new StallDetector();
  let fired;
  for (let i = 0; i < 4; i++) { fired = stuck.observe({ type: "tool", text: "명령: ao-browser screenshot" }); if (!fired) stuck.observe({ type: "tool", text: `결과: shot-${i}.png` }); }
  assert.equal(fired?.kind, "repeated-command");

  const cycle = new StallDetector();
  for (let i = 0; i < 4; i++) { cycle.observe({ type: "tool", text: "명령: ao-browser click e3" }); fired = cycle.observe({ type: "tool", text: "명령: ao-browser snapshot" }); }
  assert.equal(fired?.kind, "repeated-command");
});

test("idle detector fires after idleMs without meaningful events", () => {
  let now = 0;
  const detector = new StallDetector({ idleMs: 1_000, now: () => now });
  detector.observe({ type: "tool", text: "명령: ls" });
  now = 999; assert.equal(detector.checkIdle(), undefined);
  now = 2_000; assert.equal(detector.checkIdle()?.kind, "no-progress");
});

test("a looping worker is stopped and the orchestrator re-plans once with a new approach", async () => {
  const prompts: { role?: string; prompt: string }[] = [];
  let workerRuns = 0;
  const runner = async (options: RunCliOptions) => {
    const role = options.usageContext?.role;
    prompts.push({ role, prompt: options.prompt });
    if (role === "worker") {
      workerRuns++;
      if (workerRuns === 1) {
        for (const selector of ["#a", "#b", "#c", "#d"]) {
          if (options.signal?.aborted) break;
          options.onLine({ type: "tool", text: `명령: ao-browser text '${selector}'` });
          options.onLine({ type: "tool", text: `결과: ${warn}\n요소를 찾을 수 없습니다: ${selector}` });
          await new Promise((r) => setTimeout(r, 5));
        }
        return { exitCode: options.signal?.aborted ? 143 : 0, finalText: "" };
      }
      return { exitCode: 0, finalText: "상태: 완료\n증거: snapshot e12 확인" };
    }
    if (options.prompt.includes("위임한 워커들의 결과")) {
      if (options.prompt.includes("정체를 감지")) return { exitCode: 0, finalText: '<<DELEGATE to="grok">>## 목표\nsnapshot부터 보고 ref로 확인<</DELEGATE>>' };
      return { exitCode: 0, finalText: "검증 완료" };
    }
    return { exitCode: 0, finalText: '<<DELEGATE to="grok">>히어로 확인<</DELEGATE>>' };
  };
  const orchestra = new Orchestra(undefined, runner as never);
  const session = await orchestra.create({ prompt: "히어로 확인", agent: "grok", workers: ["grok"], cwd: process.cwd() });
  for (let i = 0; i < 200 && session.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.status, "done");
  assert.equal(workerRuns, 2);
  assert.ok(session.events.some((e) => e.type === "warning" && /정체 감지/.test(e.text)));
  assert.ok(session.events.some((e) => e.metadata?.phase === "replan"));
  assert.ok(!session.events.some((e) => /NO_COLOR/.test(e.text)));
  const firstWorker = prompts.find((p) => p.role === "worker")!.prompt;
  assert.match(firstWorker, /snapshot 먼저|ao-browser snapshot/);
  assert.match(firstWorker, /## 완료 기준 \(자동 보완\)/);
  assert.match(firstWorker, /Grok 작업자/);
  const review = prompts.find((p) => p.prompt.includes("위임한 워커들의 결과"))!.prompt;
  assert.match(review, /검증자로서 확인/);
  assert.match(prompts.find((p) => p.role === "orchestrator")!.prompt, /Grok 총괄/);
});

test("stall: same tool family with varying args", () => {
  const d = new StallDetector({ idleMs: 0 });
  let s;
  for (const sel of ["#top", "#hero-main", ".hero", "[data-hero]", "#banner", ".title"]) s = d.observe({ type: "tool", text: `명령: python3 /tmp/x/probe.py '${sel}'` });
  assert.equal(s?.kind, "tool-family-loop");
  assert.equal(commandFamily("ao-browser click e12"), "ao-browser click");
});

test("stall: consecutive failures of different classes, reset on success", () => {
  const d = new StallDetector({ idleMs: 0, repeatLimit: 99 });
  d.observe({ type: "tool", text: "오류: 요소를 찾지 못했습니다 a" });
  d.observe({ type: "tool", text: "Error: timeout waiting for selector b" });
  d.observe({ type: "tool", text: "ok: clicked" });
  for (const m of ["Error: net failure x1", "TypeError: cannot read y2", "오류: 권한이 없습니다 z3", "ERROR: selector not found q4"]) assert.equal(d.observe({ type: "tool", text: m }), undefined);
  assert.equal(d.observe({ type: "tool", text: "Exception: boom zz5" })?.kind, "no-success");
});

test("browser bridge launches the app when no window is connected", async () => {
  let windows = 0; let launched = 0; let sent: any;
  const bridge = new BrowserBridge((c) => { if (windows) sent = c; return windows; }, async () => { launched++; setTimeout(() => { windows = 1; }, 600); return true; }, 5_000);
  const p = bridge.request("status", {}, 3_000);
  await new Promise((r) => setTimeout(r, 1_300));
  assert.equal(launched, 1);
  bridge.resolve(sent.id, { ok: true, result: "ok" });
  assert.equal((await p).ok, true);
  assert.match((await new BrowserBridge(() => 0).request("status")).error ?? "", /열려 있지 않습니다/);
});

test("different commands that each exit 1 are not one repeated error (rejected push, gh auth, gh watch)", () => {
  const detector = new StallDetector();
  const steps: Array<[string, string]> = [
    ["tool", "명령: git push origin HEAD:main"],
    ["tool", "도구 결과: Exit code 1\n! [remote rejected] HEAD -> main (refusing to allow an OAuth App to create or update workflow)"],
    ["tool", "명령: gh auth status"],
    ["tool", "도구 결과: Exit code 1\ngithub.com ✓ Logged in to github.com account me (keyring)"],
    ["tool", "명령: git -c credential.helper= push origin HEAD:refs/heads/main"],
    ["tool", "도구 결과: To https://github.com/o/r.git bcffd82..015a710 HEAD -> main"],
    ["tool", "명령: gh run watch 41371716553 --exit-status"],
    ["tool", "도구 결과: Exit code 1\nRefreshing run status every 20 seconds. Press Ctrl+C to quit."],
  ];
  for (const [type, text] of steps) assert.equal(detector.observe({ type, text }), undefined, text);
  // The same command failing the same way three times still stops the worker.
  const loop = new StallDetector();
  let fired;
  for (let i = 0; i < 3; i++) {
    loop.observe({ type: "tool", text: `명령: npm test -- --grep case${i}` });
    fired = loop.observe({ type: "tool", text: "도구 결과: Exit code 1\nTypeError: x is not a function" });
  }
  assert.equal(fired?.kind, "repeated-error");
});

test("content that mentions errors is not a failure; the CLI's verdict decides", () => {
  // Reading source and docs that contain "error", "실패", "not found" is ordinary verification.
  const reads = new StallDetector();
  for (let i = 0; i < 12; i++) {
    reads.observe({ type: "tool", text: `파일 읽기: /repo/src/file${i}.ts` });
    assert.equal(reads.observe({ type: "tool", text: `도구 결과: ${i}\timport x\n2\tthrow new Error("failed: not found ${i}")\n3\t// 오류 실패`, failed: false }), undefined);
  }
  assert.equal(failureSignature("도구 결과: 콘솔 오류/경고 없음"), undefined);
  assert.equal(failureSignature("결과: # 검증 기록\n\n- 오류 없이 실패 케이스를 확인"), undefined);
  assert.equal(failureSignature("도구 결과: 1\tconst error = new Error('x')"), undefined);
  assert.equal(failureSignature("결과: ✓ src/a.test.ts (3 tests) 0 failed"), undefined);
  // A real failure still counts, with or without the verdict.
  assert.ok(failureSignature("도구 결과: Exit code 1\n오류: 요소를 찾을 수 없습니다: e3"));
  assert.ok(failureSignature("도구 결과: 파일 내용처럼 보이는 줄", true));
  const failing = new StallDetector();
  let fired;
  for (let i = 0; i < 5; i++) fired = failing.observe({ type: "tool", text: `도구 결과: 출력 ${i}`, failed: true });
  assert.ok(fired, "repeated real failures still stop the run");
});

test("Codex command JSON: started is the command, finished is its result", () => {
  const event = (id: number, status: string, command: string, output = "", exit: number | null = null) =>
    ({ type: "command", text: JSON.stringify({ id: `item_${id}`, type: "command_execution", command, aggregated_output: output, exit_code: exit, status }) });
  const reviewer = new StallDetector({ repeatLimit: 2 });
  for (let i = 0; i < 10; i++) {
    const command = `/bin/zsh -lc "cat docs/verify/file${i}.md; sed -n '1,40p' src/error-${i}.ts"`;
    assert.equal(reviewer.observe(event(i, "in_progress", command)), undefined);
    assert.equal(reviewer.observe(event(i, "completed", command, "# 검증 기록\nerror handling failed cases: none\n오류 실패", 0)), undefined);
  }
  const broken = new StallDetector();
  let fired;
  for (let i = 0; i < 5; i++) {
    broken.observe(event(i, "in_progress", `/bin/zsh -lc 'npm run step${i}'`));
    fired = broken.observe(event(i, "failed", `/bin/zsh -lc 'npm run step${i}'`, `boom ${i}`, 1));
  }
  assert.ok(fired, "repeated real failures still stop the run");
  assert.equal(unwrapShell(`/bin/zsh -lc "git status"`), "git status");
});

test("a lead reading many files in a row is not a tool loop", () => {
  const lead = new StallDetector({ repeatLimit: 2 });
  for (let i = 0; i < 20; i++) assert.equal(lead.observe({ type: "tool", text: `명령: read /repo/src/file${i}.kt` }), undefined);
});
