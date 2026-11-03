/**
 * The project lead ("담당"): one chat the user keeps giving work to, for as long as the project
 * lives. The app keeps what a long chat would otherwise lose:
 *
 * - notes the lead rewrites itself (decisions, work in progress, what is left, key paths), put in
 *   front of every turn;
 * - the whole chat as a text file the lead can search when the user refers to something old;
 * - a fresh CLI session every so many turns, handed the notes and the recent conversation, so the
 *   lead never runs on a context its CLI has squeezed;
 * - every finished turn's work merged into the main checkout (server/worktrees.ts mergeWorktree);
 * - the other projects' leads: a lead asks one with an `<<ASK>>` block and gets the answer back
 *   as a new message in its own chat;
 * - a daily report at the time the user picked, opened by the app.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Session, SessionEvent } from "./types.js";

/** Lead turns on one CLI session before the app hands the chat to a fresh one. */
export const STEWARD_ROLLOVER_TURNS = 24;
const NOTES_LIMIT = 8_000;

const NOTES = /<<NOTES>>([\s\S]*?)<<\/NOTES>>/gu;
const ASK = /<<ASK\s+to="([^"\n]{1,80})">>([\s\S]*?)<<\/ASK>>/gu;
/** Hops one user message may set off between leads (A asks B, B asks C, ...). */
export const MAX_ASK_DEPTH = 3;
const ASK_LIMIT = 4_000;
const ANSWER_LIMIT = 6_000;

/** What another lead and the sidebar call this lead: the name the user gave it, or the project folder. */
export function stewardName(session: Pick<Session, "steward" | "cwd">): string {
  return session.steward?.name?.trim() || basename(session.cwd) || session.cwd;
}

export interface StewardAsk { to: string; text: string }

/** Every `<<ASK to="name">>` block in a lead message. */
export function parseAsks(text: string): StewardAsk[] {
  return [...text.matchAll(ASK)].map((match) => ({ to: match[1].trim(), text: match[2].trim().slice(0, ASK_LIMIT) })).filter((ask) => ask.to && ask.text);
}

/** The app's blocks, left out wherever the chat is shown or quoted. */
export function stripLeadBlocks(text: string): string {
  return text.replace(/<<(CHECKLIST|NOTES)>>[\s\S]*?<<\/\1>>/gu, "").replace(ASK, "").trim();
}

export const askPrompt = (from: string, question: string) =>
  `[담당 「${from}」이 보낸 질문]\n${question}\n\n[앱] 다른 프로젝트의 담당이 보낸 메시지입니다. 이 프로젝트에서 확인해 답하세요. 이번 응답 전체가 그 담당에게 그대로 전달됩니다. 부탁받은 작업이 이 프로젝트의 일이면 평소처럼 진행하고, 결과를 답으로 정리하세요.`;

export const replyPrompt = (from: string, question: string, answer: string) =>
  `[담당 「${from}」의 답]\n질문: ${question.slice(0, 600)}\n\n${answer.slice(0, ANSWER_LIMIT)}\n\n[앱] 이 채팅에서 물어본 것에 대한 답입니다. 이 답으로 하던 일을 이어 가고, 사용자에게 알릴 것이 있으면 짧게 알리세요.`;

export const reportPrompt = () =>
  "[앱 — 정기 보고] 사용자가 정한 보고 시각입니다. 이 프로젝트의 지금 상황을 짧게 보고하세요: 지난 보고 이후 바뀐 것(git log 등으로 확인), 진행 중인 일, 막힌 것, 다음에 할 일. 확인은 해도 되지만 새 작업을 시작하지는 마세요. 사용자가 알아야 할 결정이 있으면 맨 앞에 적습니다.";

/** "HH:MM" (24h) or undefined when the value is not a time. */
export function reportTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

/** True once today's report time has passed and no report was opened since. A closed app catches up once. */
export function reportDue(time: string, reportedAt: string | undefined, now: Date): boolean {
  const [hours, minutes] = time.split(":").map(Number);
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  if (now < due) return false;
  return !reportedAt || new Date(reportedAt) < due;
}

/** The last notes block in a lead message, or undefined when it wrote none. */
export function parseNotes(text: string): string | undefined {
  const block = [...text.matchAll(NOTES)].at(-1)?.[1]?.trim();
  if (!block) return undefined;
  return block.length > NOTES_LIMIT ? `${block.slice(0, NOTES_LIMIT)}\n…(앱이 잘라냄: 노트는 짧게 유지하세요)` : block;
}

export const stewardDir = (dataDir: string, sessionId: string) => join(dataDir, "stewards", sessionId);
export const notesPath = (dataDir: string, sessionId: string) => join(stewardDir(dataDir, sessionId), "notes.md");
export const transcriptPath = (dataDir: string, sessionId: string) => join(stewardDir(dataDir, sessionId), "transcript.md");

export async function readNotes(dataDir: string, sessionId: string): Promise<string> {
  return readFile(notesPath(dataDir, sessionId), "utf8").catch(() => "");
}

export async function saveNotes(dataDir: string, sessionId: string, notes: string): Promise<void> {
  await mkdir(stewardDir(dataDir, sessionId), { recursive: true });
  await writeFile(notesPath(dataDir, sessionId), `${notes.trim()}\n`);
}

const speaker = (event: SessionEvent) => event.agent === "user" ? "사용자" : event.role === "worker" ? `워커 ${event.workerLabel ?? event.workerId ?? event.agent}` : event.role === "orchestrator" ? "담당" : event.agent;

/**
 * The chat as text the lead can grep: what was asked, answered, handed to workers and reported,
 * with times. Tool chatter is left out; it is in the events, not worth searching.
 */
export function renderTranscript(session: Pick<Session, "title" | "cwd" | "events">): string {
  const lines = [`# ${session.title}`, `작업 폴더: ${session.cwd}`, ""];
  for (const event of session.events) {
    if (event.type === "tool" || event.type === "command") continue;
    const text = stripLeadBlocks(event.text);
    if (!text) continue;
    const time = event.time.slice(0, 16).replace("T", " ");
    if (event.type === "message") lines.push(`## ${time} ${speaker(event)}`, text, "");
    else if (event.type === "delegation") lines.push(`## ${time} 위임 → ${event.workerLabel ?? event.workerId ?? event.agent}`, text, "");
    else lines.push(`- ${time} [${event.type}] ${text.replace(/\s+/gu, " ").slice(0, 400)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function saveTranscript(dataDir: string, session: Session): Promise<void> {
  await mkdir(stewardDir(dataDir, session.id), { recursive: true });
  await writeFile(transcriptPath(dataDir, session.id), renderTranscript(session));
}

export interface StewardPeer { name: string; cwd: string }

function peerRules(peers: StewardPeer[]): string {
  if (!peers.length) return "";
  return `

### 다른 프로젝트 담당
${peers.map((peer) => `- 「${peer.name}」 — \`${peer.cwd}\``).join("\n")}
다른 프로젝트에 확인하거나 부탁할 일이 있으면 응답에 아래 블록을 씁니다. 그 폴더를 직접 고치지 않습니다. 앱이 이번 턴이 끝난 뒤 전달하고, 그 담당의 답을 이 채팅의 새 메시지로 가져옵니다. 답을 기다리는 일은 체크리스트에 열어 두지 말고 "물어봄"으로 표시해 끝냅니다.
<<ASK to="담당 이름">>
(질문이나 부탁: 그 담당이 이 대화를 모른다고 생각하고 필요한 맥락을 적습니다)
<</ASK>>`;
}

export function stewardRules(notes: string, transcript: string, peers: StewardPeer[] = []): string {
  return `## 프로젝트 담당 (앱이 붙임)
당신은 이 프로젝트의 담당입니다. 사용자는 이 채팅 하나에서 계속 일을 시킵니다. 이전 대화가 기억나지 않아도 아래 노트와 기록으로 이어 갑니다.
- 담당 노트(아래)는 당신이 관리합니다. 결정, 진행 중인 일, 남은 일, 중요한 경로·명령이 바뀌면 응답 끝에 노트 전체를 새로 씁니다. 짧게(40줄 이내) 유지하고, 끝난 일의 세부는 지웁니다.
<<NOTES>>
(노트 전체)
<</NOTES>>
- 이 채팅의 전체 기록: \`${transcript}\`. 사용자가 예전에 말한 것·정한 것을 가리키면 이 파일을 검색해서 찾습니다. 추측하지 않습니다.
- 워커가 끝낸 작업은 턴이 끝날 때 앱이 메인 폴더에 병합합니다. 워커에게 작업 브랜치에 커밋하게 하세요.${peerRules(peers)}

### 지금 담당 노트
${notes.trim() || "(아직 없음: 이번 응답 끝에 처음 씁니다)"}`;
}

/** The hand-over a fresh CLI session gets in place of the old one's context. */
export function rolloverContext(notes: string, recent: string, transcript: string): string {
  return `대화가 길어져 새 세션으로 이어받았습니다. 이전 내용은 담당 노트와 전체 기록(\`${transcript}\`)에 있습니다.\n\n담당 노트:\n${notes.trim() || "(없음)"}\n\n최근 대화:\n${recent}`;
}
