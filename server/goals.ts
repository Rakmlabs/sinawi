/**
 * Run-to-completion ("끝까지") and the commander ("총지휘").
 *
 * A goal session's lead keeps a checklist of everything the request asks for. After each turn the
 * app looks at what is still open and, instead of stopping, starts the next turn itself, until every
 * item is done or blocked on something only a person can give (keys, a backend that does not exist,
 * a decision). Turns that change nothing, and the turn and time budget, end the loop.
 *
 * A commander session does no work itself: it splits the user's request into goals and the app runs
 * one goal session per goal (in order where one needs another), merges each finished goal's branch
 * into the main checkout and reports back in the commander chat.
 */
import type { GoalItem, Session } from "./types.js";

export const GOAL_MAX_AUTO_TURNS = 20;
export const GOAL_MAX_HOURS = 8;
/** Auto turns in a row that neither finish nor block an item before the loop gives up. */
export const GOAL_MAX_IDLE_TURNS = 2;
export const COMMANDER_MAX_GOALS = 8;

const CHECKLIST = /<<CHECKLIST>>([\s\S]*?)<<\/CHECKLIST>>/gu;
const ITEM = /^[ \t]*[-*][ \t]*\[([ xX!])\][ \t]*(.+?)[ \t]*$/gmu;

/** The last checklist block in a lead message, or undefined when it wrote none. */
export function parseChecklist(text: string): GoalItem[] | undefined {
  const blocks = [...text.matchAll(CHECKLIST)];
  const block = blocks.at(-1)?.[1];
  if (block === undefined) return;
  const items: GoalItem[] = [];
  for (const match of block.matchAll(ITEM)) {
    const mark = match[1];
    const [label, ...rest] = match[2].split(/[ \t]+(?:—|--)[ \t]+/u);
    const status = mark === " " ? "open" : mark === "!" ? "blocked" : "done";
    items.push({ text: label.trim(), status, ...(rest.length ? { note: rest.join(" — ").trim() } : {}) });
  }
  return items.length ? items : undefined;
}

export function renderChecklist(items: readonly GoalItem[]): string {
  return items.map((item) => `- [${item.status === "open" ? " " : item.status === "done" ? "x" : "!"}] ${item.text}${item.note ? ` — ${item.note}` : ""}`).join("\n");
}

export const openItems = (items: readonly GoalItem[] = []) => items.filter((item) => item.status === "open");

/** How many items are settled (done or blocked); the loop's measure of progress. */
export const settledCount = (items: readonly GoalItem[] = []) => items.filter((item) => item.status !== "open").length;

export const GOAL_RULES = `## 끝까지 모드 (앱이 붙임)
이 세션은 사용자가 요청한 일을 전부 끝낼 때까지 앱이 턴을 이어 간다. 한 턴에 다 하려 하지 말고, 체크리스트로 관리한다.
- 응답마다 체크리스트 전체를 이 형식으로 쓴다(빠진 항목 없이, 순서 유지):
<<CHECKLIST>>
- [ ] 아직 안 한 항목 (완료 기준이 보이게 한 줄)
- [x] 끝나고 검증한 항목
- [!] 사람만 풀 수 있는 항목 — 막힌 이유와 필요한 것
<</CHECKLIST>>
- 첫 응답에서는 사용자 원문의 요청을 하나도 빠뜨리지 않고 항목으로 나눈다. 큰 일은 검증할 수 있는 단위로 쪼갠다.
- [x]는 워커 보고와 파일·테스트로 확인한 것만 표시한다. 보고만 보고 체크하지 않는다.
- [!]는 키·계정·결제·존재하지 않는 외부 API·사용자의 결정처럼 에이전트가 할 수 없는 것만이다. 어렵거나 실패했다는 이유로 쓰지 않는다. 막힌 항목이 있어도 나머지는 계속한다.
- 남은 [ ] 항목이 있으면 이번 응답에서 다음 항목을 워커에게 위임한다. 앱이 다음 턴을 연다.
- 각 항목이 끝나면 워커가 작업 브랜치에 커밋하게 한다(메시지에 무엇을 했는지).`;

export function goalTurnPrompt(items: readonly GoalItem[], turn: number): string {
  const open = openItems(items);
  return `[앱 — 끝까지 모드 ${turn}번째 이어가기] 아래는 지금 체크리스트입니다. 지난 턴의 결과를 작업 트리의 파일·커밋·테스트로 확인해 체크리스트를 고치고, 남은 항목 중 다음 것을 워커에게 위임하세요. 남은 항목 ${open.length}개.\n\n<<CHECKLIST>>\n${renderChecklist(items)}\n<</CHECKLIST>>`;
}

export type GoalStop = "complete" | "idle" | "turns" | "time" | "no-checklist";

/** Whether the loop starts another turn after one ends, and why not when it does not. */
export function nextGoalStep(session: Pick<Session, "goal">, now = Date.now()): { continue: true } | { continue: false; reason: GoalStop } {
  const goal = session.goal;
  if (!goal?.items.length) return { continue: false, reason: "no-checklist" };
  if (!openItems(goal.items).length) return { continue: false, reason: "complete" };
  if (goal.idleTurns >= GOAL_MAX_IDLE_TURNS) return { continue: false, reason: "idle" };
  if (goal.autoTurns >= GOAL_MAX_AUTO_TURNS) return { continue: false, reason: "turns" };
  if (now - Date.parse(goal.startedAt) >= GOAL_MAX_HOURS * 3_600_000) return { continue: false, reason: "time" };
  return { continue: true };
}

export const GOAL_STOP_TEXT: Record<GoalStop, string> = {
  complete: "체크리스트를 모두 마쳤습니다.",
  idle: `${GOAL_MAX_IDLE_TURNS}턴 연속 진전이 없어 멈췄습니다.`,
  turns: `자동 턴 상한(${GOAL_MAX_AUTO_TURNS}턴)에 닿아 멈췄습니다.`,
  time: `시간 상한(${GOAL_MAX_HOURS}시간)에 닿아 멈췄습니다.`,
  "no-checklist": "총괄이 체크리스트를 쓰지 않아 이어 가지 않았습니다.",
};

// ---------------------------------------------------------------------------------------------
// Commander

export interface ParsedGoal { key: string; title: string; brief: string; after: string[] }

const GOAL_BLOCK = /<<GOAL([^>]*)>>([\s\S]*?)<<\/GOAL>>/gu;
const attr = (attrs: string, name: string) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "u").exec(attrs)?.[1]?.trim();

/** `known`: goal keys already on the board, which a new goal may also wait on. */
export function parseGoals(text: string, known: Iterable<string> = []): ParsedGoal[] {
  const goals: ParsedGoal[] = [];
  for (const match of text.matchAll(GOAL_BLOCK)) {
    const body = match[2].trim();
    if (!body) continue;
    const key = attr(match[1], "id") || `g${goals.length + 1}`;
    const title = attr(match[1], "title") || body.split("\n")[0].replace(/^#+\s*/u, "").slice(0, 80);
    const after = (attr(match[1], "after") ?? "").split(/[,\s]+/u).filter(Boolean);
    if (goals.some((goal) => goal.key === key)) continue;
    goals.push({ key, title, brief: body, after });
    if (goals.length >= COMMANDER_MAX_GOALS) break;
  }
  const keys = new Set([...known, ...goals.map((goal) => goal.key)]);
  // Only dependencies on goals that exist count; anything else would wait forever.
  return goals.map((goal) => ({ ...goal, after: goal.after.filter((key) => keys.has(key) && key !== goal.key) }));
}

export const COMMANDER_RULES = `당신은 Sinawi의 총지휘입니다. 직접 파일을 고치거나 워커에게 위임하지 않습니다. 사용자의 요청을 독립적으로 끝낼 수 있는 목표로 나누면, 앱이 목표마다 별도 세션을 열어 끝까지 실행하고, 검증된 결과를 메인 브랜치에 병합한 뒤 이 채팅으로 알려 줍니다.

목표는 정확히 이 형식으로 씁니다(최대 ${COMMANDER_MAX_GOALS}개):
<<GOAL id="g1" title="짧은 제목">>
## 목표
## 완료 기준
## 정본 (읽을 문서·파일 경로)
## 제약
<</GOAL>>
<<GOAL id="g2" title="..." after="g1">>...<</GOAL>>

- 한 목표는 한 세션이 한 작업 브랜치에서 끝낼 수 있는 크기다. 같은 파일을 많이 고치는 일은 한 목표로 묶는다.
- 앞 목표의 결과가 있어야 하는 목표만 after에 그 id를 쓴다. 나머지는 동시에 돈다.
- 사용자 원문의 요청을 빠짐없이 목표에 나눠 담는다. 사람만 할 수 있는 일(키, 결제, 없는 외부 API)은 목표로 만들지 말고 마지막에 따로 적는다.
- 먼저 저장소를 읽기 전용으로 살펴 정본 경로를 정확히 적는다. 추측한 경로를 쓰지 않는다.
- 목표가 진행 중일 때 사용자가 말을 걸면, 이미 있는 목표와 겹치지 않는 새 목표만 같은 형식으로 추가한다. 상태만 묻는 말이면 아래 보드 기준으로 답한다.
- 모든 목표가 끝났다는 앱의 알림을 받으면, 목표별 결과·병합 여부·막힌 것과 사용자가 해야 할 일을 짧게 정리한다.`;

export function commanderBoard(session: Pick<Session, "commander">, sessions: (id: string) => Session | undefined): string {
  const goals = session.commander?.goals ?? [];
  if (!goals.length) return "";
  const lines = goals.map((goal) => {
    const child = goal.childId ? sessions(goal.childId) : undefined;
    const items = child?.goal?.items ?? [];
    const progress = items.length ? ` (${settledCount(items)}/${items.length})` : "";
    const blocked = items.filter((item) => item.status === "blocked").map((item) => `${item.text}${item.note ? ` — ${item.note}` : ""}`);
    return `- [${goal.key}] ${goal.title}: ${goalStateLabel(goal.state)}${progress}${goal.merge ? ` · ${goal.merge.text}` : ""}${blocked.length ? `\n  막힘: ${blocked.join("; ")}` : ""}`;
  });
  return `## 목표 보드 (앱이 붙임)\n${lines.join("\n")}`;
}

export function goalStateLabel(state: NonNullable<Session["commander"]>["goals"][number]["state"]): string {
  return { waiting: "대기", running: "진행 중", done: "완료", merged: "병합됨", blocked: "막힘", failed: "실패", stopped: "중지됨" }[state];
}
