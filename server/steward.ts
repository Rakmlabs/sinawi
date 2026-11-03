/**
 * The project lead ("담당"): one chat the user keeps giving work to, for as long as the project
 * lives. The app keeps what a long chat would otherwise lose:
 *
 * - notes the lead rewrites itself (decisions, work in progress, what is left, key paths), put in
 *   front of every turn;
 * - the whole chat as a text file the lead can search when the user refers to something old;
 * - a fresh CLI session every so many turns, handed the notes and the recent conversation, so the
 *   lead never runs on a context its CLI has squeezed;
 * - every finished turn's work merged into the main checkout (server/worktrees.ts mergeWorktree).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session, SessionEvent } from "./types.js";

/** Lead turns on one CLI session before the app hands the chat to a fresh one. */
export const STEWARD_ROLLOVER_TURNS = 24;
const NOTES_LIMIT = 8_000;

const NOTES = /<<NOTES>>([\s\S]*?)<<\/NOTES>>/gu;

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
    const text = event.text.replace(/<<(CHECKLIST|NOTES)>>[\s\S]*?<<\/\1>>/gu, "").trim();
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

export function stewardRules(notes: string, transcript: string): string {
  return `## 프로젝트 담당 (앱이 붙임)
당신은 이 프로젝트의 담당입니다. 사용자는 이 채팅 하나에서 계속 일을 시킵니다. 이전 대화가 기억나지 않아도 아래 노트와 기록으로 이어 갑니다.
- 담당 노트(아래)는 당신이 관리합니다. 결정, 진행 중인 일, 남은 일, 중요한 경로·명령이 바뀌면 응답 끝에 노트 전체를 새로 씁니다. 짧게(40줄 이내) 유지하고, 끝난 일의 세부는 지웁니다.
<<NOTES>>
(노트 전체)
<</NOTES>>
- 이 채팅의 전체 기록: \`${transcript}\`. 사용자가 예전에 말한 것·정한 것을 가리키면 이 파일을 검색해서 찾습니다. 추측하지 않습니다.
- 워커가 끝낸 작업은 턴이 끝날 때 앱이 메인 폴더에 병합합니다. 워커에게 작업 브랜치에 커밋하게 하세요.

### 지금 담당 노트
${notes.trim() || "(아직 없음: 이번 응답 끝에 처음 씁니다)"}`;
}

/** The hand-over a fresh CLI session gets in place of the old one's context. */
export function rolloverContext(notes: string, recent: string, transcript: string): string {
  return `대화가 길어져 새 세션으로 이어받았습니다. 이전 내용은 담당 노트와 전체 기록(\`${transcript}\`)에 있습니다.\n\n담당 노트:\n${notes.trim() || "(없음)"}\n\n최근 대화:\n${recent}`;
}
