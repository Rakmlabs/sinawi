/**
 * The project lead ("담당"): one chat the user keeps giving work to, for as long as the project
 * lives. The app keeps what a long chat would otherwise lose:
 *
 * - notes the lead rewrites itself (decisions, work in progress, what is left, key paths), put in
 *   front of every turn;
 * - the whole chat as a text file the lead can search when the user refers to something old;
 * - a fresh CLI session every so many turns, handed the notes and the recent conversation, so the
 *   lead never runs on a context its CLI has squeezed;
 * - every finished turn's work merged into the main checkout (server/worktrees.ts mergeWorktree),
 *   held for the user's approval, or left on its branch, as the lead's merge policy says;
 * - the user's own preferences (user-preferences.md in the data folder), put in front of every
 *   lead's turn next to its notes;
 * - the other projects' leads: a lead asks one with an `<<ASK>>` block and gets the answer back
 *   as a new message in its own chat;
 * - a daily report at the time the user picked, opened by the app.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import type { AgentId, GoalItem, MergePolicy, PendingMerge, Session, SessionEvent, Steward } from "./types.js";

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

export const askPrompt = (from: string, question: string, acceptWork = false) =>
  `[담당 「${from}」이 보낸 질문]\n${question}\n\n[앱] 다른 프로젝트의 담당이 보낸 메시지입니다. 이 프로젝트에서 확인해 답하세요. 이번 응답 전체가 그 담당에게 그대로 전달됩니다. ${acceptWork
    ? "부탁받은 작업이 이 프로젝트의 일이면 평소처럼 진행하고, 결과를 답으로 정리하세요."
    : "읽어서 확인만 하고 답하세요. 사용자가 다른 담당의 부탁으로 작업하는 것을 허락하지 않았으므로 파일을 고치거나 워커에게 맡기지 않습니다(앱이 위임을 막습니다). 작업이 필요하면 무엇을 해야 하는지 답에 적고, 사용자가 이 채팅에서 시키면 그때 합니다."}`;

export const replyPrompt = (from: string, question: string, answer: string) =>
  `[담당 「${from}」의 답]\n질문: ${question.slice(0, 600)}\n\n${answer.slice(0, ANSWER_LIMIT)}\n\n[앱] 이 채팅에서 물어본 것에 대한 답입니다. 이 답으로 하던 일을 이어 가고, 사용자에게 알릴 것이 있으면 짧게 알리세요.`;

/** `others`: the lead's other chats, so one report covers all of them. */
export const reportPrompt = (others: { title: string; status: string; transcript?: string }[] = []) =>
  `[앱 — 정기 보고] 사용자가 정한 보고 시각입니다. 이 프로젝트의 지금 상황을 짧게 보고하세요: 지난 보고 이후 바뀐 것(git log 등으로 확인), 진행 중인 일, 막힌 것, 다음에 할 일. 확인은 해도 되지만 새 작업을 시작하지는 마세요. 사용자가 알아야 할 결정이 있으면 맨 앞에 적습니다.${others.length ? `\n\n이 담당의 다른 채팅도 함께 보고하세요(보고는 담당마다 한 번, 이 채팅에서 합니다):\n${others.map((item) => `- 「${item.title}」 (${item.status})${item.transcript ? ` — 기록: \`${item.transcript}\`` : ""}`).join("\n")}` : ""}`;

/**
 * The report settings a lead's chats had one by one, as one lead's: the earliest time (so no report
 * comes later than one the user had), the latest reportedAt and its git state (so nothing reports
 * twice). `times` lists every distinct time found, to tell the user when they differed.
 */
export function mergeThreadReports(chats: Pick<NonNullable<Session["steward"]>, "report" | "reportedAt" | "reportState">[]): { report?: string; reportedAt?: string; reportState?: string; times: string[] } {
  const times = [...new Set(chats.flatMap((chat) => chat.report ? [chat.report] : []))].sort();
  const reported = chats.filter((chat) => chat.reportedAt).sort((a, b) => b.reportedAt!.localeCompare(a.reportedAt!))[0];
  return {
    ...(times[0] ? { report: times[0] } : {}),
    ...(reported?.reportedAt ? { reportedAt: reported.reportedAt } : {}),
    ...(reported?.reportState !== undefined ? { reportState: reported.reportState } : {}),
    times,
  };
}

/** "HH:MM" (24h) or undefined when the value is not a time. */
export function reportTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

const run = promisify(execFile);

/** The project's commit and uncommitted changes, to tell whether anything changed since the last report. */
export async function projectState(cwd: string): Promise<string> {
  const git = (...args: string[]) => run("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => stdout.trim(), () => "");
  const [head, status] = await Promise.all([git("rev-parse", "HEAD"), git("status", "--porcelain")]);
  return `${head}\n${status}`;
}

export const isReportPrompt = (text: string) => text.startsWith("[앱 — 정기 보고]");

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

export const MERGE_POLICIES: readonly MergePolicy[] = ["auto", "ask", "never"];
export const DEFAULT_MERGE_POLICY: MergePolicy = "ask";
/** Leads migrated from older lead chats merged every turn; the user may pick "ask" for them instead (StewardSettings). */
export const LEGACY_MERGE_POLICY: MergePolicy = "auto";
export const isMergePolicy = (value: unknown): value is MergePolicy => MERGE_POLICIES.includes(value as MergePolicy);

/**
 * A Steward entity for a lead chat that has none (one saved before leads were their own thing, or
 * whose entity file was lost): everything the chat was started with, so nothing changes for it.
 * Such a lead merged every turn, so it keeps "auto" by default; new leads pass DEFAULT_MERGE_POLICY.
 * The id defaults to the chat's own, so the notes it already has (stewards/<id>/notes.md) stay its notes.
 */
export function stewardFromSession(session: Session, options: { id?: string; mergePolicy?: MergePolicy; now?: string } = {}): Steward {
  const { id = session.steward?.id ?? session.id, mergePolicy = LEGACY_MERGE_POLICY, now = new Date().toISOString() } = options;
  return {
    id, name: stewardName(session), agent: session.agent,
    ...(session.model ? { model: session.model } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    workers: structuredClone(session.workerConfigs ?? session.workers.map((agent) => ({ agent }))),
    skills: [...(session.skills ?? [])], systemPrompt: session.systemPrompt ?? "",
    mergePolicy,
    cwds: [session.cwd], workspaceId: session.workspaceId, createdAt: session.steward?.since || session.createdAt || now,
  };
}

/** What may change on a Steward through the API. */
export type StewardPatch = Partial<Pick<Steward, "name" | "systemPrompt" | "skills" | "agent" | "model" | "reasoningEffort" | "workers" | "mergePolicy" | "cwds">>;

/** The Steward after a patch; `model`/`reasoningEffort` set to "" are cleared. */
export function applyStewardPatch(steward: Steward, patch: StewardPatch, now = new Date().toISOString()): Steward {
  const next: Steward = { ...steward, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: now };
  if (!next.model) delete next.model;
  if (!next.reasoningEffort) delete next.reasoningEffort;
  return next;
}

/** Notes belong to the Steward, so every thread of one lead reads and writes the same notes. */
export const stewardNotesId = (session: Pick<Session, "id" | "steward">) => session.steward?.id ?? session.id;

/** The rule the lead is given about its workers' branches. */
export function mergeRule(policy: MergePolicy = "auto"): string {
  if (policy === "auto") return "워커가 끝낸 작업은 턴이 끝날 때 앱이 메인 폴더에 병합합니다. 워커에게 작업 브랜치에 커밋하게 하세요.";
  if (policy === "ask") return "워커가 끝낸 작업은 턴이 끝나면 사용자가 승인할 때까지 작업 브랜치에 남습니다. 사용자가 담당 패널에서 승인하면 앱이 메인 폴더에 병합합니다. 워커에게 작업 브랜치에 커밋하게 하고, 최종 답에 병합 승인이 필요하다고 짧게 알리세요.";
  return "앱은 워커 브랜치를 메인 폴더에 병합하지 않습니다. 워커에게 작업 브랜치에 커밋하게 하고, 최종 답에 브랜치 이름을 적어 사용자가 직접 병합한다고 알리세요.";
}

/** The status line shown when a chat becomes a lead. */
export const stewardStartText = (policy: MergePolicy = "auto") =>
  `이 채팅을 프로젝트 담당으로 정했습니다. 대화 기록을 이어 가며, ${policy === "auto" ? "끝낸 작업은 메인 폴더에 병합합니다" : policy === "ask" ? "끝낸 작업은 승인을 받은 뒤 메인 폴더에 병합합니다" : "끝낸 작업은 작업 브랜치에 남겨 둡니다"}.`;

export const USER_PREFERENCES_LIMIT = 8_000;
export const userPreferencesPath = (dataDir: string) => join(dataDir, "user-preferences.md");

/** What the user wants from every lead (tone, tools, habits), shared by all of them. */
export async function readUserPreferences(dataDir: string): Promise<string> {
  return readFile(userPreferencesPath(dataDir), "utf8").then((text) => text.trim(), () => "");
}

export async function saveUserPreferences(dataDir: string, text: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const trimmed = text.trim().slice(0, USER_PREFERENCES_LIMIT);
  await writeFile(userPreferencesPath(dataDir), trimmed ? `${trimmed}\n` : "", { mode: 0o600 });
}

export interface SessionSummary {
  id: string;
  title: string;
  status: Session["status"];
  cwd: string;
  endedAt?: string;
  /** The lead's last answer, with the app's blocks left out. */
  lastAnswer: string;
  checklist: GoalItem[];
  pendingMerge: PendingMerge | null;
  steward: (Pick<Steward, "id" | "name" | "mergePolicy" | "agent" | "skills" | "cwds"> & { turns: number; report: string | null }) | null;
}

/** One chat at a glance: what it is doing, what it said last and what waits for the user. */
export function sessionSummary(session: Session, steward?: Steward): SessionSummary {
  const report = steward ? steward.report : session.steward?.report;
  let lastAnswer = "";
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index];
    if (event.type !== "message" || event.agent === "user" || event.role === "worker") continue;
    lastAnswer = stripLeadBlocks(event.text);
    if (lastAnswer) break;
  }
  return {
    id: session.id, title: session.title, status: session.status, cwd: session.cwd,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    lastAnswer, checklist: session.goal?.items ?? [],
    pendingMerge: session.steward?.pendingMerge ?? null,
    steward: session.steward ? {
      id: steward?.id ?? stewardNotesId(session), name: steward?.name || stewardName(session),
      mergePolicy: steward?.mergePolicy ?? DEFAULT_MERGE_POLICY, agent: steward?.agent ?? session.agent,
      skills: steward?.skills ?? session.skills ?? [], cwds: steward?.cwds ?? [session.cwd],
      turns: session.steward.turns, report: report ?? null,
    } : null,
  };
}

/** A lead's folder under <data>/stewards. The ID comes from stored data: one that is not a plain name cannot leave that folder. */
export function stewardDir(dataDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/u.test(sessionId) || sessionId.includes("..")) throw new Error(`담당 ID가 올바르지 않습니다: ${sessionId}`);
  return join(dataDir, "stewards", sessionId);
}
export const notesPath = (dataDir: string, sessionId: string) => join(stewardDir(dataDir, sessionId), "notes.md");
export const transcriptPath = (dataDir: string, sessionId: string) => join(stewardDir(dataDir, sessionId), "transcript.md");

export async function readNotes(dataDir: string, sessionId: string): Promise<string> {
  return readFile(notesPath(dataDir, sessionId), "utf8").catch(() => "");
}

export async function saveNotes(dataDir: string, sessionId: string, notes: string): Promise<void> {
  await mkdir(stewardDir(dataDir, sessionId), { recursive: true });
  await writeFile(notesPath(dataDir, sessionId), `${notes.trim()}\n`, { mode: 0o600 });
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
  await writeFile(transcriptPath(dataDir, session.id), renderTranscript(session), { mode: 0o600 });
}

export interface StewardPeer { name: string; cwd: string }

function peerRules(peers: StewardPeer[]): string {
  if (!peers.length) return "";
  return `

### 다른 프로젝트 담당
${peers.map((peer) => `- 「${peer.name}」 — \`${peer.cwd}\``).join("\n")}
다른 프로젝트에 확인하거나 부탁할 일이 있으면 응답에 아래 블록을 씁니다. 그 폴더를 직접 고치지 않습니다. 앱이 이번 턴이 끝난 뒤 전달하고, 그 담당의 답을 이 채팅의 새 메시지로 가져옵니다. 답을 기다리는 일은 체크리스트에 열어 두지 말고 "물어봄"으로 표시해 끝냅니다.
같은 공간의 담당에게만 물을 수 있습니다. 다른 공간 담당에게는 이름이나 ID로도 물을 수 없습니다.
<<ASK to="담당 이름">>
(질문이나 부탁: 그 담당이 이 대화를 모른다고 생각하고 필요한 맥락을 적습니다)
<</ASK>>`;
}

export interface StewardRuleOptions {
  mergePolicy?: MergePolicy;
  /** The user's common preferences (user-preferences.md). */
  preferences?: string;
  /** Agents the workspace allows: the lead may hand work to one that is not on its team yet. */
  allowedAgents?: AgentId[];
}

function switchRule(allowed: AgentId[] | undefined): string {
  if (!allowed?.length) return "";
  return `\n- 사용자가 워커 CLI를 바꿔 달라고 하면(예: "코덱스 말고 클로드로 해") 그 에이전트 이름으로 위임합니다: <<DELEGATE to="claude">>…<</DELEGATE>>. 팀에 없으면 앱이 그 워커를 팀에 넣고 실행합니다. 이 작업공간에서 쓸 수 있는 에이전트: ${allowed.join(", ")}. 다른 에이전트는 앱이 막습니다.`;
}

export function stewardRules(notes: string, transcript: string, peers: StewardPeer[] = [], appNotes: string[] = [], options: StewardRuleOptions = {}): string {
  return `## 프로젝트 담당 (앱이 붙임)
당신은 이 프로젝트의 담당입니다. 사용자는 이 채팅 하나에서 계속 일을 시킵니다. 이전 대화가 기억나지 않아도 아래 노트와 기록으로 이어 갑니다.
- 담당 노트(아래)는 당신이 관리합니다. 결정, 진행 중인 일, 남은 일, 중요한 경로·명령이 바뀌면 응답 끝에 노트 전체를 새로 씁니다. 짧게(40줄 이내) 유지하고, 끝난 일의 세부는 지웁니다.
<<NOTES>>
(노트 전체)
<</NOTES>>
- 이 채팅의 전체 기록: \`${transcript}\`. 사용자가 예전에 말한 것·정한 것을 가리키면 이 파일을 검색해서 찾습니다. 추측하지 않습니다.
- ${mergeRule(options.mergePolicy)}${switchRule(options.allowedAgents)}${peerRules(peers)}

${appNotes.length ? `\n### 지난 턴이 끝난 뒤 앱이 한 일\n${appNotes.map((note) => `- ${note}`).join("\n")}\n노트에 아직 반영되지 않았다면 이번 응답 끝에 고쳐 씁니다.\n` : ""}
### 지금 담당 노트
${notes.trim() || "(아직 없음: 이번 응답 끝에 처음 씁니다)"}${options.preferences?.trim() ? `

### 사용자 공통 선호 (사용자가 설정에서 씀, 모든 담당 공통)
${options.preferences.trim().slice(0, USER_PREFERENCES_LIMIT)}
이 선호를 따르되, 사용자가 이 채팅에서 다르게 말하면 그 말을 따릅니다.` : ""}`;
}

/** The hand-over a fresh CLI session gets in place of the old one's context. */
export function rolloverContext(notes: string, recent: string, transcript: string): string {
  return `대화가 길어져 새 세션으로 이어받았습니다. 이전 내용은 담당 노트와 전체 기록(\`${transcript}\`)에 있습니다.\n\n담당 노트:\n${notes.trim() || "(없음)"}\n\n최근 대화:\n${recent}`;
}
