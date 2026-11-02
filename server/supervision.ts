/**
 * Orchestration supervision: delegation briefs, worker operating rules, tool-output
 * noise filtering, and a stall/loop detector. See docs/orchestration/OPERATING-RULES.md.
 */
import type { AgentId } from "./types.js";

/** Sections every orchestrator → worker brief must carry (R1). */
export const BRIEF_SECTIONS = ["목표", "맥락", "완료 기준", "제약", "검증", "보고 형식"] as const;
export type BriefSection = typeof BRIEF_SECTIONS[number];

const sectionAliases: Record<BriefSection, RegExp> = {
  목표: /목표|goal|objective|할\s*일/iu,
  맥락: /맥락|배경|context|현재\s*상태|이미\s*있는/iu,
  "완료 기준": /완료\s*기준|성공\s*기준|done\s*(?:when|criteria)|success\s*criteria|acceptance/iu,
  제약: /제약|금지|하지\s*마|반드시\s*지킬|constraints?|do\s*not|must\s*not|건드리지/iu,
  검증: /검증|확인\s*방법|verif|테스트/iu,
  "보고 형식": /보고\s*형식|보고할\s*것|report\s*format|출력\s*형식/iu,
};

function headingLines(task: string): string[] {
  return task.split("\n").filter((line) => /^\s*(?:#{1,6}\s|\*\*|[-*]\s+\*\*)/u.test(line) || /^\s*[^\n:：]{1,20}[:：]/u.test(line));
}

/** Which brief sections a delegated task is missing. */
export function missingBriefSections(task: string): BriefSection[] {
  const heads = headingLines(task).join("\n");
  return BRIEF_SECTIONS.filter((section) => !sectionAliases[section].test(heads));
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const DEFAULT_REPORT_FORMAT = [
  "상태: 완료 | 부분 완료 | 막힘 중 하나",
  "한 일: 실제로 바꾼 파일·실행한 명령 (짧게)",
  "증거: 검증 명령과 그 출력 요지, 테스트 결과, 스크린샷/파일 경로",
  "남은 문제: 막힌 지점, 추측한 부분, 사용자 결정이 필요한 것",
].join("\n");

/** Auto-fills missing brief sections so every worker gets goal/context/criteria/constraints/verification/report. */
export function ensureBrief(task: string, userPrompt: string): { text: string; missing: BriefSection[] } {
  const missing = missingBriefSections(task);
  if (!missing.length) return { text: task, missing };
  const defaults: Record<BriefSection, string> = {
    목표: "위 지시를 그대로 수행한다.",
    맥락: `사용자 원래 요청(참고용):\n${clip(userPrompt.trim(), 1_500)}`,
    "완료 기준": "요청한 결과물이 실제로 존재하고, 아래 검증 방법으로 확인되었을 때만 완료다. 확인 못 했으면 '부분 완료'로 보고한다.",
    제약: "맡은 범위 밖 파일은 수정하지 않는다. 다른 작업자의 변경을 되돌리지 않는다. 수정하는 파일에 적용되는 가장 가까운 AGENTS.md, CLAUDE.md, GEMINI.md를 따른다. 커밋·push·배포·삭제·외부 전송 등 되돌릴 수 없는 작업은 지시에 명시된 경우에만 한다. 사용자 승인이 필요한 결정은 하지 말고 보고한다.",
    검증: "끝났다고 하기 전에 브리프의 검증을 직접 실행한다(관련 테스트·타입체크, 파일 존재·내용 확인, UI는 ao-browser snapshot/screenshot). 확인한 명령과 결과를 증거로 남긴다. 실행하지 못했으면 완료가 아니다.",
    "보고 형식": DEFAULT_REPORT_FORMAT,
  };
  const filled = missing.map((section) => `## ${section} (자동 보완)\n${defaults[section]}`).join("\n\n");
  return { text: `${task.trim()}\n\n${filled}`, missing };
}

/**
 * App facts for whoever is driving this GUI. The long form is
 * docs/orchestration/prompts/app-guide.md. Injected into both roles.
 */
export const APP_GUIDE = `## 이 앱에서 일하기
이 세션은 Sinawi 창 안에서 돌아간다. 사용자에게 보이는 답은 한국어로 짧게 쓴다.
- 총괄은 계획, 위임, 검증, 보고만 한다. 워커는 <<DELEGATE>>로 받은 6개 제목 브리프만 본다. 총괄 대화와 다른 워커의 로그는 워커에게 보이지 않는다.
- 세션 작업 폴더는 시작할 때 고정되고, 그 폴더가 명령의 작업 디렉터리다. CLI 세션은 같은 총괄·같은 워커의 다음 턴에 이어진다. 이어받아도 브리프의 맥락은 다시 적는다.
- 앱 뷰어는 세션 작업 폴더와 미리보기 첨부 폴더 안만 연다. 결과 이미지·PDF·목업은 그 작업 폴더에 두고, 최종 답에 상대 경로를 마크다운으로 적는다. 예: \`![화면](preview/home.png)\`. 채팅이 그 경로를 뷰어로 연다. HTML 목업은 뷰어가 실행하지 않으므로 앱 브라우저로 연다.
- 작업이 돌아가는 동안 채팅은 열려 있다. "뭐 해", "어디까지" 같은 상태 질문은 로그를 읽는 별도 답이 나간다. 그 답은 도구도 위임도 하지 않는다. "해 줘", "부터 봐" 같은 지시는 다음 턴에 \`사용자가 진행 중에 보낸 지시\`로 붙는다. 그 문단이 보이면 이미 시작한 일을 버리지 말고 그 턴에 반영한다. "멈춰"는 즉시 중지다. 사용자에게 입력을 멈추라고 하지 않는다.
- 사용자가 고른 화면 요소는 \`orchestra-attachments\` 블록이다. 메모가 요청이다. selector는 그 페이지의 CSS이고 ao-browser의 ref(e12)가 아니다. React 컴포넌트와 소스(file:line)가 고칠 위치다. 요소 캡처와 전체 화면 캡처 경로는 이미지로 읽어 확인한다.
- 금지: 외부 Chrome, Playwright, \`open\`으로 브라우저나 결과 파일을 띄우는 것. 포트 3100과 3101을 열거나 그 프로세스를 건드리는 것. 사용자가 명시하지 않은 프로세스 kill. 앱 서버 포트(보통 3001)를 열거나 끄는 것.`;

/**
 * Operational ao-browser rules. Command details live in
 * docs/orchestration/prompts/in-app-browser.md.
 */
export const BROWSER_CORE = `## 앱 브라우저 (ao-browser)
결과물, 목업, 디자인 시안, UI 확인은 앱 안 브라우저로만 연다. 명령은 \`ao-browser\`이고, 없으면 \`node\`로 \`~/.local/bin/ao-browser\`를 부른다. 필요한 규칙은 이 문단에 다 있다. Sinawi 소스나 문서를 찾아 읽지 않는다.
- 총괄의 읽기 전용 확인은 snapshot, text, console, screenshot까지다. click, fill, type으로 화면을 바꾸지 않고, 조작은 워커 브리프의 검증에 적어 워커가 한다.
- 데스크톱 앱에서는 localhost와 외부 http/https 주소를 모두 열고 조작한다. 포트만 적어도 된다(\`ao-browser goto 5173\`). file:// 는 열리지 않는다. 브라우저 모드(\`npm run dev\`)에서는 localhost만 조작된다.
- 정적 파일은 로컬 HTTP로 띄운 뒤 연다. 명령 하나: \`python3 -m http.server 8765 --directory <작업 폴더 안 상대 경로>\`. Codex와 Claude는 이 명령을 백그라운드로 두고 다음 호출에서 연다. 루트는 \`ao-browser goto 8765\`, 파일 경로는 \`ao-browser goto localhost:8765/index.html\`이다. \`8765/index.html\`처럼 포트와 경로를 붙이면 주소가 아니다. Grok은 \`&\`와 \`bash -c\`가 거절되므로 이미 떠 있는 포트를 쓰고, 없으면 부분 완료로 서버가 필요하다고 보고한다. 포트 3100, 3101, 3001은 쓰지 않는다. 띄운 서버를 kill 하지 않는다.
- 순서: \`ao-browser goto <포트 또는 주소>\` 다음 \`ao-browser snapshot\`. 출력된 ref(e12)로만 click, fill, text 한다. click/fill/press 등은 바뀐 snapshot을 같이 돌려준다. 화면이 바뀌거나 "페이지가 이동했습니다"가 나오면 다시 snapshot. 화면 크기는 \`ao-browser viewport iphone|tablet|desktop|390x844\`. iphone과 tablet은 모바일 user-agent와 터치를 켠다. 증거는 \`ao-browser screenshot\`이다. 나온 PNG는 임시 폴더라 채팅 뷰어가 열지 못한다. 보여 줄 그림은 작업 폴더로 옮긴 뒤 마크다운에 적는다.
- 첨부 selector는 snapshot에서 같은 글자와 역할을 찾아 그 ref를 쓴다. ref가 없으면 첨부 selector를 한 번만 쓴다(\`ao-browser text "<selector>"\`). 선택자를 새로 만들어 여러 번 찍지 않는다. "요소를 찾을 수 없습니다"면 snapshot부터 다시 한다.
- "앱 창이 열려 있지 않습니다" 또는 "앱이 실행 중이 아닙니다"면 같은 명령을 한 번만 다시 보낸다. 서버가 앱을 띄우고 최대 15초 기다린다. 앱은 3초마다 연결을 보고, 9초 연속 창이 없으면 창을 다시 로드한다. "최소화됐거나 화면이 잠겨" 또는 "사용자가 AI 조작을 중지"면 반복하지 말고 막힘으로 보고한다. 같은 실패가 세 번째면 막힘이다.
- 명령: goto, snapshot, click, fill, type, press, scroll, wait, text, console, screenshot, back, forward, reload, tabs, status. open과 navigate는 goto, shot은 screenshot이다.`;

/** Operational ao-computer rules. Details: docs/orchestration/prompts/computer-use.md. */
export const COMPUTER_CORE = `## 컴퓨터 조작 (ao-computer)
웹 페이지는 ao-browser로 다룬다. 파일·셸·CLI로 안 되는 네이티브 앱(TextEdit, Finder, 시스템 설정 등)만 \`ao-computer\`로 조작한다. 필요한 규칙은 이 문단에 다 있다. Sinawi 소스, 로그, 스킬 파일을 찾아 읽지 않는다.
- 작업 공간 설정 "컴퓨터 조작 허용"이 꺼져 있으면 모든 명령이 거부된다(기본 꺼짐). \`ao-computer status\`로 확인하고, 꺼져 있으면 사용자에게 켜 달라고 보고하고 멈춘다.
- 첫 명령 때 사용자가 허용 여부를 고른다. 거부, 권한 없음, 사용자 중지(Esc 길게·⌃⌥⌘.) 오류가 나오면 반복하지 말고 바로 보고한다.
- 순서: screenshot으로 보고 → ax의 ref로 ax_click/ax_set_value(좌표보다 우선) → 다시 screenshot으로 확인. 같은 실패 세 번이면 막힘으로 보고한다.
- 비밀번호 칸 입력, 결제·전송·삭제처럼 되돌릴 수 없는 조작은 사용자가 명시하지 않았으면 하지 않는다.`;

/** Rules prepended to every orchestrator prompt (R1, R4, R5). */
export const ORCHESTRATOR_RULES = `## 위임 규칙 (Sinawi 운영 규칙)
당신의 일은 계획, 위임, 검증, 보고입니다. 워커에게 맡긴 일은 워커가 하는 동안 직접 하지 않습니다. 읽기 전용 확인만 허용됩니다. 사용자가 물으면 답한 뒤 조정을 계속합니다.
- 위임 본문에는 반드시 다음 6개 제목을 쓴다: ## 목표 / ## 맥락 / ## 완료 기준 / ## 제약 / ## 검증 / ## 보고 형식. 빠진 칸은 앱이 기본값으로 채우지만, 구체적일수록 결과가 좋다.
- 맥락에는 워커가 다시 찾지 않아도 되는 사실(경로, 이미 확인된 값, 이전 시도와 실패 이유)을 적는다. 워커는 이 대화를 보지 못한다. 다른 워커가 같은 저장소에서 만지는 파일이 있으면 적고, 그 변경을 되돌리지 말라고 적는다.
- 완료 기준은 확인 가능한 문장으로 쓴다(예: "npm test 통과", "?hero=c에서 video src가 /preview/c/loop.mp4").
- 단계는 2개 이상일 때만 계획한다. 한 단계짜리 계획은 만들지 않는다. 서로 독립적인 단계만 병렬로 나누고, 같은 파일을 두 워커에게 동시에 맡기지 않는다.
- 코드베이스가 낯설면 구현 전에 읽기 전용 탐색을 위임해 핵심 파일 5~10개와 한 줄 이유를 받는다. 그 파일은 총괄이 읽고 계획에 반영한다.
- 출력이 큰 테스트·빌드는 워커에게 맡기고 요약만 받는다. 워커에게 하위 워커를 만들라고 시키지 않는다.
- 수정하는 파일에 적용되는 AGENTS.md, CLAUDE.md, GEMINI.md 규칙을 제약에 옮긴다. 더 깊은 폴더의 파일이 우선하고, 사용자 지시와 이 브리프가 그 파일보다 우선한다.
- 내가 만들지 않은 예상 밖 변경이 보이면 멈추고 보고한다. 되돌리지 않는다.
- 되돌릴 수 없는 작업(커밋·push·배포·삭제·결제·외부 전송)은 사용자가 명시하지 않았으면 위임하지 말고 사용자에게 확인을 받는다.
- 최종 답은 결과, 검증 증거, 남은 문제 순으로 짧게 쓴다. 확인하지 못한 것을 완료라고 쓰지 않는다. 경로와 명령은 백틱으로 감싼다.

${APP_GUIDE}

${BROWSER_CORE}

${COMPUTER_CORE}`;

/** Rules prepended to every worker prompt (R2, R3, R6, R7). */
export const WORKER_RULES = `## 작업자 운영 규칙 (Sinawi)
- 편집하기 전에 대상 파일을 읽는다. 내용을 추측해서 고치지 않는다. 다음 단계가 이전 도구 결과에 의존하면, 그 결과를 확인한 뒤에만 진행한다.
- 브라우저(ao-browser): goto 뒤에는 반드시 \`ao-browser snapshot\`으로 실제 요소 목록을 먼저 보고, 반환된 ref(예: e12)로 click/fill/text 한다. CSS 선택자를 짐작해서 여러 개 시도하지 않는다. 화면이 바뀌면 다시 snapshot. "요소를 찾을 수 없습니다"가 나오면 선택자를 바꿔 재시도하지 말고 snapshot부터 다시 본다.
- 같은 오류가 3번 나오거나 같은 수정이 3번 실패하면 같은 방법을 더 시도하지 말고 멈춘다. 원래 목표, 시도한 것, 오류, 틀렸을 수 있는 가정을 '막힘'으로 보고한다. 앱도 반복 오류·장시간 무진전을 감지하면 작업을 중단시키고 총괄이 다시 계획한다.
- 주석이나 TODO로 구현을 대신하지 않는다. 요청한 범위만 완전히 구현하고, 관련 없는 수정은 하지 않는다.
- 라이브러리, 명령, 스크립트가 있다고 가정하지 않는다. package.json, Cargo.toml, requirements, 저장소 스크립트에서 확인한다.
- 다른 작업자나 사용자가 만든 변경은 되돌리지 않는다. 내가 만든 변경도 오류를 고치려는 경우가 아니면 되돌리지 않는다.
- 수정하는 파일을 포함하는 가장 가까운 AGENTS.md, CLAUDE.md, GEMINI.md를 따른다. 더 깊은 폴더가 우선하고, 이 브리프와 사용자 지시가 그 파일보다 우선한다.
- 끝났다고 보고하기 전에 브리프의 검증을 직접 실행하고 증거(명령과 출력 요지, 경로)를 남긴다. 검증하지 못했으면 '부분 완료'라고 쓴다.
- 지시받지 않은 범위로 넓히지 않는다. 승인이 필요한 결정은 하지 말고 보고한다. 최종 보고 끝에 질문이나 추가 제안을 붙이지 않는다.
- 최종 보고 형식:
${DEFAULT_REPORT_FORMAT}

${APP_GUIDE}

${BROWSER_CORE}

${COMPUTER_CORE}`;

/**
 * Programs pre-approved for headless Claude (`--allowedTools`) and Grok (`--allow`).
 * A Grok command outside this list cancels the whole run, because nobody can approve a prompt.
 */
export const DEVELOPMENT_SHELL_PROGRAMS = ["git", "gh", "ls", "cat", "rg", "find", "npm", "pnpm", "yarn", "node", "npx", "tsc", "du", "wc", "head", "tail", "ao-browser", "ffprobe", "ffmpeg", "python3", "mkdir", "file", "stat", "sips", "pwd", "echo", "sort", "jq"] as const;

/** Harness-specific corrections appended after the shared rules. */
export function cliNotes(agent: AgentId, role: "orchestrator" | "worker"): string {
  const programs = DEVELOPMENT_SHELL_PROGRAMS.join(", ");
  const notes: Record<AgentId, Record<"orchestrator" | "worker", string>> = {
    codex: {
      orchestrator: `## Codex 총괄
- update_plan은 여러 단계이거나 모호한 작업에만 쓴다. 쉬운 작업(대략 가장 쉬운 40%)과 한 단계 계획은 만들지 않는다. 각 단계는 짧은 한 줄이고, 진행 중(in_progress)은 항상 하나다. pending에서 completed로 건너뛰지 말고, 다음 단계로 가기 전에 끝난 단계를 completed로 표시한다. 계획 전문을 다시 옮기지 않는다.
- 워커 제약에 그 파일이 속한 AGENTS.md 범위를 적는다. 저장소 루트부터 작업 폴더까지는 Codex가 이미 넣는다. 그 아래 폴더나 작업 폴더 밖만 워커가 확인한다. 같은 폴더에 AGENTS.override.md가 있으면 그것이 AGENTS.md를 대신한다. 더 깊은 파일이 우선하고, 사용자 지시와 이 브리프가 그 파일보다 우선한다.
- 독립인 단계만 병렬로 맡긴다. 워커가 일하는 동안 같은 일을 하지 않고 끝날 때까지 기다린다. 로그가 큰 검증은 워커에게 맡기고 요약만 받는다. 워커에게 하위 에이전트를 만들지 말라고 적고, 같은 트리의 다른 워커 변경을 되돌리지 말라고 적는다.
- 최종 답은 결과부터 쓴다. 작은 변경은 제목 없이 3불릿 안, 보통은 6불릿 안이다. 경로는 백틱 하나(path:line)이고, 줄 범위와 고친 파일 전문은 넣지 않는다.`,
      worker: `## Codex 작업자
- 한 파일 수정은 apply_patch만 쓴다. 도구 이름은 apply_patch이고 JSON으로 감싸지 않는다. applypatch나 apply-patch는 없다. 포매터, 생성물, 여러 파일의 같은 치환은 명령으로 한다.
- apply_patch가 성공하면 그 파일을 다시 읽지 않는다. 패치가 실패하면 그때 읽는다.
- 루트부터 작업 폴더까지의 AGENTS.md는 이미 주입되어 있다. 다시 읽지 않는다. 그 아래나 작업 폴더 밖을 고칠 때만 가장 가까운 AGENTS.md를 확인한다. AGENTS.override.md가 있으면 그것을 따른다. 더 깊은 파일이 우선하고, 이 브리프가 그 파일보다 우선한다.
- 검증은 바꾼 코드에 가장 가까운 테스트부터 넓혀 간다. 관련 없는 실패는 고치지 않는다. 포매터는 3번까지만 맞추고, 그래도 안 되면 그 사실을 보고한다. 이 실행은 비대화형이다. 승인을 기다리지 말고 브리프의 검증을 실행한다.
- 최종 보고는 결과부터 쓴다. 작은 변경은 제목 없이 3불릿 안, 여러 파일이면 파일당 1~2불릿이다. 고친 내용의 전문과 before/after는 넣지 않고 경로만 백틱으로 적는다. 줄 번호는 path:line 하나이고 범위는 쓰지 않는다.
- 검색은 rg를 우선한다. git commit, 새 브랜치, git reset --hard, git checkout -- 는 브리프에 없을 때 하지 않는다.`,
    },
    claude: {
      orchestrator: `## Claude 총괄
- 요청한 범위만 위임한다. 탐색은 읽기 전용으로 두고 구현과 섞지 않는다. claude -p는 Agent 도구와 포크 서브에이전트가 기본으로 켜져 있다. 워커에게 그 도구를 부르지 말라고 제약에 적는다.
- 고칠 파일의 CLAUDE.md와 그 경로의 .claude/rules를 제약에 옮긴다. 프로젝트에 CLAUDE.md가 없으면 AGENTS.md가 그 자리다. 중첩 파일은 그 폴더에만 적용되고, 이 브리프가 우선한다. 작업이 CLAUDE.md 자체를 고치면, 나머지 변경의 리뷰 기준은 고치기 전 규칙이라고 적는다.
- 리뷰는 버그, 회귀, 빠진 테스트만 번호 목록으로 받는다. JSON 배열로 받지 않는다. 각 항목에 파일, 줄, 왜 깨지는지를 붙이라고 적는다. 근거 없는 지적, 스타일 취향, 기존 문제는 빼고, 없으면 발견 없음이라고 쓰게 한다.
- 검증에는 실행할 명령과 기대 결과를 적는다. 증거 없는 완료는 완료로 받지 않는다. 파일을 보게 할 때는 Read를 쓰라고 적는다. cat, head, tail, sed -n, grep으로는 중첩 CLAUDE.md가 붙지 않을 수 있다.`,
      worker: `## Claude 작업자
- 파일은 Read로 본다. cat, head, tail, sed -n, grep으로 보면 그 폴더의 중첩 CLAUDE.md와 .claude/rules가 붙지 않을 수 있다. 프로젝트에 CLAUDE.md가 없으면 AGENTS.md를 따른다. 아주 긴 CLAUDE.md는 앞부분만 보였을 수 있으니 통째로 덮어쓰지 않는다.
- 요청한 것만 고친다. 같이 고치고 싶은 리팩터나 스타일 수정은 하지 않는다.
- TodoWrite와 TaskCreate, TaskUpdate, TaskList, TaskGet은 이 세션이 그 도구를 제공할 때만 쓴다. 단계가 3개 미만이거나 한 가지 일이면 만들지 않는다. 호출할 때마다 목록 전체를 보내고, 목록이 바뀔 때만 다시 호출한다. 시작한 항목은 in_progress, 실제로 끝나면 바로 completed로 바꾼다. 도구가 없으면(최신 모델은 CLAUDE_CODE_ENABLE_TODO_TOOLS가 없으면 꺼져 있다) 채팅에 할 일 목록을 만들지 않는다.
- Agent 도구, 포크 서브에이전트, 추가 워커를 만들지 않는다. 이 세션이 워커다.
- 리뷰라면 버그, 회귀, 빠진 테스트만 심각도 순의 번호 목록으로 적는다. 각 항목에 파일, 줄, 재현이나 깨지는 이유를 붙인다. 근거가 없으면 빼고, 없으면 발견 없음이라고 쓴다. 스타일 취향과 기존 문제는 적지 않는다. JSON 배열로 끝내지 않는다. 변경이 CLAUDE.md를 포함하면 나머지 파일은 고치기 전 규칙으로 본다.
- 끝났다는 문장 앞에 검증 명령과 출력 요지를 둔다. 출력을 보지 않았으면 부분 완료다.`,
    },
    grok: {
      orchestrator: `## Grok 총괄
- 워커가 실패하거나 명령이 거부되면 직접 고치지 말고 다른 접근으로 재위임한다. 읽기 전용 확인만 한다.
- 셸은 허용된 프로그램 하나씩이다. &&, ||, ;, cd, 변수 대입, 명령 치환, bash -c 로 이어 붙이지 않는다. 허용되지 않은 명령은 그 실행 전체를 취소한다.
- 워커 브리프의 검증도 허용된 프로그램 하나의 명령으로 적는다. 여러 단계면 명령을 나눠 적는다. 허용 목록: ${programs}.
- 도구 결과를 두 번 말하지 않는다. 실패는 거부된 명령과 이유만 짧게 보고 바로 재위임한다.`,
      worker: `## Grok 작업자
- 이 실행은 헤드리스다. 승인 창은 없고, 미리 허용되지 않은 셸 명령은 실행 전체를 취소한다.
- 허용된 프로그램만 쓴다: ${programs}. 각 호출은 그중 하나로 시작하는 명령 하나다.
- cd, &&, ||, ;, 변수 대입, $(...), 반복문, bash -c 는 쓰지 않는다. 경로는 절대 경로나 작업 폴더 기준 상대 경로로 쓴다. 긴 로직은 .py로 저장한 뒤 python3로 한 번 실행한다.
- 명령이 거부되거나 취소되면 다른 형태로 재시도하지 않는다. 즉시 막힘으로 보고하고, 거부된 명령과 이유를 증거에 적는다.
- 도구 결과는 한 번만 읽고 반복해서 옮기지 않는다. 보고는 상태, 한 일, 증거, 남은 문제 네 줄을 빠짐없이 쓴다.`,
    },
  };
  return notes[agent][role];
}

/** Swaps CLI notes when quota fallback runs a prompt that was written for another CLI. */
export function retargetCliNotes(prompt: string, from: AgentId, to: AgentId, role: "orchestrator" | "worker"): string {
  if (from === to) return prompt;
  const previous = cliNotes(from, role);
  if (!prompt.includes(previous)) return prompt;
  return prompt.split(previous).join(cliNotes(to, role));
}

const noisePatterns: RegExp[] = [
  /\(node:\d+\) Warning: The '(?:NO_COLOR|FORCE_COLOR)' env is ignored due to the '(?:FORCE_COLOR|NO_COLOR)' env being set\.?[ \t]*(?:\r?\n)?(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)[ \t]*)?(?:\r?\n)?/gu,
];

/** Removes known meaningless tool-output prefixes (e.g. Node's NO_COLOR/FORCE_COLOR warning). */
export function stripToolNoise(text: string): string {
  let next = text;
  for (const pattern of noisePatterns) next = next.replace(pattern, "");
  return next === text ? text : next.replace(/^(결과|도구 결과):\s*\n+/u, "$1: ").trimEnd();
}

/** True when a line carries nothing once noise is removed. */
export function isPureNoise(text: string): boolean {
  const stripped = stripToolNoise(text);
  return stripped !== text && !stripped.replace(/^(?:결과|도구 결과)\s*:?/u, "").trim();
}

/** Env for CLI children: never set NO_COLOR and FORCE_COLOR together (Node warns on every process). */
export function cliChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}

const failurePattern = /요소를 찾을 수 없|찾을 수 없습니다|not found|no such|cannot find|could not find|timed? ?out|시간 초과|error|failed|failure|exception|denied|거부|실패|오류|traceback|exit code [1-9]|종료 코드 [1-9]/iu;

/** Collapses a failure line to a signature so variants (different selector/pid/path) count as the same error. */
export function failureSignature(text: string): string | undefined {
  const cleaned = stripToolNoise(text);
  const lines = cleaned.split("\n").map((part) => part.trim()).filter(Boolean);
  const index = lines.findIndex((part) => failurePattern.test(part));
  if (index < 0) return;
  let head = lines[index].replace(/^(?:결과|도구 결과|명령)\s*:\s*/u, "");
  // A bare "Exit code 1" says nothing about what failed; the next line does (a rejected push and
  // a gh watch both exit 1 but are different failures).
  if (/^(?:exit code|종료 코드)\s*\d+$/iu.test(head) && lines[index + 1]) head = `${head} ${lines[index + 1]}`;
  // "요소를 찾을 수 없습니다: #a" and ": #b" are the same failure: drop the detail after the message.
  const hit = failurePattern.exec(head);
  const cut = hit ? head.indexOf(":", hit.index + hit[0].length) : -1;
  // Keep the message when the part before ":" is only a label like "오류" / "Error".
  if (cut > 0 && cut >= 10) head = head.slice(0, cut);
  return head
    .replace(/(["'`])(?:(?!\1).){0,400}\1/gu, "<q>")
    .replace(/(?:\/[\w.@-]+){2,}/gu, "<path>")
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\b0x[0-9a-f]+\b|\d+(?:\.\d+)?/giu, "#")
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .slice(0, 160);
}

export interface StallSignal { kind: "repeated-error" | "repeated-command" | "no-progress" | "tool-family-loop" | "no-success"; reason: string; evidence: string[] }
export interface StallOptions { repeatLimit?: number; familyLimit?: number; failLimit?: number; window?: number; idleMs?: number; now?: () => number }

/**
 * Watches one worker run. Fires when the same failure signature (or the exact same
 * command) repeats `repeatLimit` times inside the last `window` tool lines, or when no
 * meaningful event arrives for `idleMs`.
 */
const INTERPRETERS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "npx", "tsx", "deno", "bun", "ruby"]);
const SUBCOMMAND_TOOLS = new Set(["ao-browser", "git", "npm", "pnpm", "yarn", "gh", "docker", "kubectl", "cargo"]);
/** Tool family of a shell command: "python3 probe.py", "ao-browser click", ignoring varying args. */
export function commandFamily(command: string): string {
  const tokens = command.trim().split(/\s+/u).filter((t) => !/^[A-Z_][A-Z0-9_]*=/u.test(t));
  const base = (t = "") => t.replace(/^['"]|['"]$/gu, "").split("/").pop() ?? "";
  const head = base(tokens[0]);
  if (INTERPRETERS.has(head) || SUBCOMMAND_TOOLS.has(head)) {
    const next = tokens.slice(1).find((t) => !t.startsWith("-"));
    return `${head} ${base(next)}`.trim();
  }
  return head;
}

export class StallDetector {
  readonly repeatLimit: number;
  readonly window: number;
  readonly idleMs: number;
  private now: () => number;
  private recent: { signature?: string; command?: string; text: string }[] = [];
  private lastProgress: number;
  private fired?: StallSignal;
  private lastText?: string;
  readonly familyLimit: number;
  readonly failLimit: number;
  private familyRun = { family: "", count: 0 };
  private failuresSinceSuccess = 0;
  private lastFamily = "";

  constructor(options: StallOptions = {}) {
    this.repeatLimit = options.repeatLimit ?? 3;
    this.window = options.window ?? 15;
    this.idleMs = options.idleMs ?? 8 * 60_000;
    this.now = options.now ?? Date.now;
    this.familyLimit = options.familyLimit ?? 6;
    this.failLimit = options.failLimit ?? 5;
    this.lastProgress = this.now();
  }

  get signal(): StallSignal | undefined { return this.fired; }

  observe(line: { type: string; text: string }): StallSignal | undefined {
    if (this.fired) return this.fired;
    if (isPureNoise(line.text)) return;
    this.lastProgress = this.now();
    // CLIs sometimes echo the same tool result twice in a row; count it once.
    if (line.text === this.lastText) return;
    this.lastText = line.text;
    if (!["tool", "command", "error", "warning"].includes(line.type)) return;
    const commandMatch = /^명령:\s*(.+)$/su.exec(line.text.trim());
    const command = commandMatch ? commandMatch[1].replace(/\s+/gu, " ").trim() : undefined;
    // Failures count as "the same" only within one tool family: a rejected git push and a failing
    // gh run watch are different problems even when their output looks alike.
    const failure = command ? undefined : failureSignature(line.text);
    const signature = failure && this.lastFamily ? `${this.lastFamily}: ${failure}` : failure;
    this.recent.push({ signature, command, text: clip(stripToolNoise(line.text).replace(/\s+/gu, " "), 200) });
    if (this.recent.length > this.window) this.recent.shift();
    if (command) {
      const family = commandFamily(command);
      this.lastFamily = family;
      this.familyRun = family === this.familyRun.family ? { family, count: this.familyRun.count + 1 } : { family, count: 1 };
    } else if (signature) {
      this.failuresSinceSuccess++;
    } else if (line.type === "tool") {
      // A tool result without a failure marker counts as progress.
      this.failuresSinceSuccess = 0;
      this.familyRun = { family: "", count: 0 };
    }
    if (this.failuresSinceSuccess >= this.failLimit) {
      this.fired = { kind: "no-success", reason: `성공 없이 ${this.failuresSinceSuccess}번 연속 실패했습니다(오류 종류는 다를 수 있음).`, evidence: this.recent.slice(-this.failLimit).map((item) => item.text) };
      return this.fired;
    }
    if (command && this.familyRun.count >= this.familyLimit) {
      this.fired = { kind: "tool-family-loop", reason: `같은 도구(${this.familyRun.family})를 인자만 바꿔 성공 없이 ${this.familyRun.count}번 연속 실행했습니다.`, evidence: this.recent.slice(-this.familyLimit).map((item) => item.text) };
      return this.fired;
    }
    if (signature) {
      const hits = this.recent.filter((item) => item.signature === signature);
      if (hits.length >= this.repeatLimit) {
        this.fired = { kind: "repeated-error", reason: `같은 오류가 ${hits.length}번 반복됐습니다: ${signature}`, evidence: hits.map((item) => item.text) };
      }
    } else if (command) {
      const hits = this.recent.filter((item) => item.command === command);
      if (hits.length >= this.repeatLimit + 1) {
        this.fired = { kind: "repeated-command", reason: `같은 명령을 ${hits.length}번 반복했습니다: ${clip(command, 120)}`, evidence: hits.map((item) => item.text) };
      }
    }
    return this.fired;
  }

  /**
   * Raw CLI output that renders nothing (partial-message deltas, thinking): the run is alive, so
   * the idle clock restarts. Loop detection is unaffected because nothing is recorded.
   */
  heartbeat(): void {
    if (!this.fired) this.lastProgress = this.now();
  }

  /** Call periodically; fires when nothing meaningful happened for idleMs. */
  checkIdle(): StallSignal | undefined {
    if (this.fired) return this.fired;
    const idle = this.now() - this.lastProgress;
    if (this.idleMs > 0 && idle >= this.idleMs) {
      this.fired = { kind: "no-progress", reason: `${Math.round(idle / 60_000)}분 동안 진전이 없습니다.`, evidence: this.recent.slice(-5).map((item) => item.text) };
    }
    return this.fired;
  }
}

/** Orchestrator prompt after a round of worker results: verify, then finish or re-plan (R4, R5). */
export function reviewPrompt(results: string[], originalContext: string, roundsLeft: number): string {
  const replan = roundsLeft > 0
    ? `\n- 정체·중단·증거 부족·완료 기준 미달이 있으면, (a) 원래 목표를 한 줄로 다시 적고, (b) 틀렸을 수 있는 가정을 나열하고, (c) 원인을 한 줄로 진단한 뒤 **다른 접근**으로 새 <<DELEGATE>>를 출력하세요(같은 방법 반복 금지, 위임 규칙의 6개 제목 사용). 남은 재위임 기회: ${roundsLeft}회.\n- 모두 기준을 충족하면 위임 없이 최종 답을 쓰세요.`
    : "\n- 더 이상 위임할 수 없습니다. 추가 위임은 하지 마세요. 확인된 것과 확인되지 않은 것을 구분해 최종 답을 쓰세요.";
  return `위임한 워커들의 결과입니다. 최종 답 전에 검증자로서 확인하세요. 파일을 수정하거나 구현 명령을 실행하지 마세요. 읽기 전용 확인만 합니다. 이 검토는 구현 세션과 분리된 읽기 전용 검토입니다.
- 이번 워커 변경만 보세요. 기존에 있던 버그는 빼세요.
- 심각도: [P0] 깨짐, [P1] 이번 변경의 회귀, [P2] 빠진 테스트, [P3] 이번 변경의 다른 결함. 파일과 이유를 한 단락으로 쓰세요. 없으면 "발견 없음".
- 각 보고를 원래 요청과 위임 때 정한 완료 기준에 하나씩 대조하세요. '완료'라고만 하고 증거(명령 출력, 테스트 결과, 경로)가 없으면 미확인으로 취급하세요. UI 증명은 ao-browser snapshot 또는 screenshot 경로입니다. 외부 브라우저와 Playwright로 연 결과는 완료 증거로 받지 않습니다.
- 보고의 증거를 그대로 믿지 마세요. 파일 읽기와 git diff/status/log/show로 다시 확인하세요. 테스트·빌드·스크립트는 직접 실행하지 마세요(이 검토 권한으로는 실행되지 않습니다). 워커 보고에 남은 테스트 명령과 출력을 읽고, 증거가 없거나 의심스러우면 다시 실행을 <<DELEGATE>>로 워커에게 맡기세요.
- 보고할 문제만 적으세요: 테스트·타입 실패, 입력과 상관없이 틀리는 로직, 브리프 제약 위반, 요청 범위를 벗어난 변경. 스타일 취향, 추측, 원래부터 있던 문제는 빼세요.
- 필요하면 읽기 전용으로 직접 확인하세요(파일 읽기, 워커가 남긴 테스트 출력 읽기). 확인하지 못한 것을 완료라고 쓰지 마세요.${replan}
- 최종 답은 결과, 검증 증거, 남은 문제 순으로 짧게 쓰세요. 경로와 명령은 백틱으로 감싸세요.${originalContext}\n\n${results.join("\n\n")}`;
}

export interface CompactEvent {
  agent?: string;
  type?: string;
  text?: string;
  role?: string;
  taskStatus?: string;
  workerId?: string;
  delegationId?: string;
}

const COMPACT_LIMIT = 2_000;

function compactLine(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Progress, decisions, remaining work, and the next step before a resumed session. */
export function compactHandoff(events: CompactEvent[], workerId?: string): string {
  const scoped = workerId
    ? events.filter((event) => event.workerId === workerId || event.agent === "user" || event.role === "orchestrator")
    : events;
  const lines = (items: CompactEvent[]) => items.map((event) => `- ${compactLine(event.text ?? "")}`).filter((line) => line !== "- ");
  const progress = lines(scoped.filter((event) => event.type === "status" || event.type === "message" || event.type === "delegation").slice(-8));
  const decisions = lines(scoped.filter((event) => /결정|제약|하지 말|금지|가정/.test(event.text ?? "") || event.type === "delegation").slice(-5));
  const closed = new Set(scoped.filter((event) => event.delegationId && (event.taskStatus === "done" || event.taskStatus === "error")).map((event) => event.delegationId));
  const open = scoped.filter((event) => event.type === "delegation" && event.taskStatus !== "done" && !(event.delegationId && closed.has(event.delegationId)));
  const remaining = lines(open.length ? open.slice(-5) : scoped.filter((event) => /남은|미완|다음/.test(event.text ?? "")).slice(-5));
  const next = [...scoped].reverse().find((event) => event.agent === "user" && event.type === "message");
  const summary = [
    "## 진행",
    progress.join("\n") || "- 기록 없음",
    "## 결정·제약",
    decisions.join("\n") || "- 기록 없음",
    "## 남은 일",
    remaining.join("\n") || "- 기록 없음",
    "## 다음 단계",
    next?.text ? compactLine(next.text, 400) : "- 기록 없음",
  ].join("\n");
  return summary.length > COMPACT_LIMIT ? `${summary.slice(0, COMPACT_LIMIT - 1)}…` : summary;
}
