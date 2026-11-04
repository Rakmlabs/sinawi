import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { LEAD_WAIT_LIMIT_SEC } from "./lead-tools.js";

/**
 * Every Sinawi feature as an MCP tool, in one registry. Two surfaces read it:
 *  - "lead": the per-run `sinawi_lead` server a project lead's CLI gets (POST /api/lead-mcp);
 *  - "external": the stdio server `scripts/sinawi-mcp.mjs` that Claude Desktop and other AIs start
 *    (POST /api/app-mcp, token in the data folder).
 * The AI picks a tool from its description; nothing here routes by keywords.
 *
 * App tools do not reimplement anything: each one names the HTTP route it drives and runs that
 * route's own handler in-process (`injectRequest`), so validation, persistence and broadcasts are
 * the ones the UI gets. Lead-only tools (delegating to workers, waiting on results) go to
 * Orchestra.leadToolCall, which needs the lead's live turn.
 *
 * Risk decides how a call runs: "read" and "write" (creating, sending, renaming) run at once;
 * "approval" (deleting, settings, merges, stopping, anything hard to undo) only creates a pending
 * approval the user answers in the app (server/app-approvals.ts).
 */
export type ToolRisk = "read" | "write" | "approval";
export type ToolSurface = "lead" | "external";

type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  /** Runs an app API route in-process; rejects with the route's error message on a 4xx/5xx. */
  dispatch(method: string, path: string, body?: unknown): Promise<unknown>;
  /** The lead's own tools (Orchestra.leadToolCall); only on the lead surface. */
  leadCall?(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Workspace a call without workspace_id means: the lead's, or the app's current one. */
  workspaceId?: string;
}

export interface AppTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  surfaces: ToolSurface[];
  /** The app routes this tool drives, as "METHOD /path" in the Express pattern. */
  routes: string[];
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** Line on the approval card (approval tools); `names` turns IDs into the names the user knows. */
  summary?(args: Record<string, unknown>, names: NameLookup): string;
}

/**
 * Names for the IDs an approval mentions: "채팅 'API 정리' (3f2a9c1e)". The server's lookup reads
 * its sessions, leads and workspaces; an ID it does not know is shown as is.
 */
export interface NameLookup {
  session(id: unknown): string;
  lead(id: unknown): string;
  workspace(id: unknown): string;
  schedule(id: unknown): string;
  group(id: unknown): string;
  bot(id: unknown): string;
}

/** "'name' (short id)", the name first and the ID as a hint; just the ID when the name is unknown. */
export function namedLabel(name: string | undefined, id: unknown): string {
  const raw = id === undefined || id === null ? "" : String(id);
  const short = raw.length > 12 ? raw.slice(0, 8) : raw;
  const clean = name?.trim();
  if (!clean) return raw || "(없음)";
  return short && short !== clean ? `'${clean}' (${short})` : `'${clean}'`;
}

/** A lookup from maps of id → name; anything missing falls back to the ID. */
export function nameLookup(names: Partial<Record<keyof NameLookup, (id: string) => string | undefined>> = {}): NameLookup {
  const make = (kind: keyof NameLookup) => (id: unknown) => namedLabel(typeof id === "string" && id ? names[kind]?.(id) : undefined, id);
  return { session: make("session"), lead: make("lead"), workspace: make("workspace"), schedule: make("schedule"), group: make("group"), bot: make("bot") };
}

// ---------- argument helpers ----------

const str = (description: string): JsonSchema => ({ type: "string", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const strings = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const agentEnum = (description: string): JsonSchema => ({ type: "string", enum: ["claude", "codex", "grok"], description });
const workspaceArg = str("워크스페이스(공간) ID. 비우면 지금 워크스페이스.");

function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key}가 필요합니다.`);
  return value.trim();
}
const seg = (args: Record<string, unknown>, key: string) => encodeURIComponent(need(args, key));
const opt = (value: unknown) => (value === undefined || value === null || value === "" ? undefined : value);

function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (opt(value) !== undefined) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Drops undefined so a PATCH only sends what the AI gave. */
function defined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Plan/auto only: full access is the user's call in the app, never an AI's. */
function permissionMode(value: unknown): "plan" | "auto" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "plan" || value === "auto") return value;
  throw new Error("permission_mode는 plan 또는 auto만 됩니다. 전체 권한(full)은 사용자가 앱에서 직접 켜야 합니다.");
}

function workerSelections(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("workers는 목록이어야 합니다.");
  return value.map((item) => typeof item === "string" ? { agent: item } : item);
}

interface RouteToolSpec {
  name: string;
  description: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  risk: ToolRisk;
  surfaces?: ToolSurface[];
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  route: string;
  path?(args: Record<string, unknown>, ctx: ToolContext): string;
  body?(args: Record<string, unknown>, ctx: ToolContext): unknown;
  pick?(output: unknown, args: Record<string, unknown>): unknown;
  summary?(args: Record<string, unknown>, names: NameLookup): string;
}

const BOTH: ToolSurface[] = ["lead", "external"];

function routeTool(spec: RouteToolSpec): AppTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: "object", properties: spec.properties ?? {}, ...(spec.required?.length ? { required: spec.required } : {}) },
    risk: spec.risk,
    surfaces: spec.surfaces ?? BOTH,
    routes: [`${spec.method} ${spec.route}`],
    summary: spec.summary,
    async run(args, ctx) {
      const path = spec.path ? spec.path(args, ctx) : spec.route;
      const output = await ctx.dispatch(spec.method, path, spec.body?.(args, ctx));
      return spec.pick ? spec.pick(output, args) : output ?? { ok: true };
    },
  };
}

function leadTool(spec: { name: string; description: string; properties?: Record<string, JsonSchema>; required?: string[]; risk: ToolRisk; summary?(args: Record<string, unknown>, names: NameLookup): string }): AppTool {
  return {
    name: spec.name, description: spec.description, risk: spec.risk, surfaces: ["lead"], routes: [], summary: spec.summary,
    inputSchema: { type: "object", properties: spec.properties ?? {}, ...(spec.required?.length ? { required: spec.required } : {}) },
    async run(args, ctx) {
      if (!ctx.leadCall) throw new Error(`${spec.name}는 담당 실행에서만 쓸 수 있습니다.`);
      return ctx.leadCall(spec.name, args);
    },
  };
}

// ---------- presentation (the API returns whole sessions; the AI needs the gist) ----------

type Row = Record<string, any>;
const clip = (text: unknown, max: number) => typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;

function sessionRow(session: Row) {
  return defined({
    id: session.id, title: session.title, status: session.status, agent: session.agent, workers: session.workers, cwd: session.cwd,
    workspaceId: session.workspaceId, groupId: session.groupId, createdAt: session.createdAt, endedAt: session.endedAt,
    lead: session.steward ? defined({ id: session.steward.id, name: session.steward.name }) : undefined,
    events: Array.isArray(session.events) ? session.events.length : undefined,
  });
}

function eventRow(event: Row) {
  return defined({ id: event.id, type: event.type, role: event.role, agent: event.agent, workerId: event.workerId, time: event.time, text: clip(event.text, 4_000) });
}

/** Drops MCP servers' launch details (command, args, URL) from a /api/tools payload, wherever the rows sit. */
export function withoutLaunchDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLaunchDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Row)
    .filter(([key]) => key !== "url/command" && key !== "command" && key !== "url" && key !== "args" && key !== "env" && key !== "headers")
    .map(([key, item]) => [key, withoutLaunchDetails(item)]));
}

// ---------- the registry ----------

const scheduleTiming = {
  at: str("한 번 실행할 시각. '2026-11-04T09:00'(시간대 기준) 또는 오프셋이 있는 ISO 시각."),
  cron: str("반복 일정. 5칸 cron '분 시 일 월 요일' (예: '0 9 * * 1-5' 평일 9시)."),
  timezone: str("IANA 시간대. 비우면 이 컴퓨터의 시간대."),
};

/** Lead-only tools (were server/lead-tools.ts LEAD_TOOLS): they need the lead's live turn. */
const LEAD_ONLY: AppTool[] = [
  leadTool({
    name: "delegate_task", risk: "write",
    description: "워커(Claude/Codex/Grok CLI)에게 일을 맡기고 바로 task_id를 돌려받는다. 여러 번 부르면 동시에 실행된다. 같은 CLI를 두 번 맡겨도 각자 다른 워커로 병렬 실행된다. 결과는 collect_results로 받는다. 디자인·UI 작업은 kind:'design'.",
    properties: {
      brief: str("워커에게 줄 구체적인 지시. 목표, 맥락, 바꿀 파일, 완료 조건, 보고 형식을 적는다."),
      worker: str("기존 워커 ID(예: 'codex-2'). 비우면 agent로 고른다."),
      agent: agentEnum("워커 CLI. 쉬는 같은 CLI 워커가 없으면 새 워커를 만든다."),
      model: str("모델(선택)."),
      skills: strings("브리프에 붙일 스킬 이름(write_skill로 만든 것 또는 설치된 스킬)."),
      group: str("묶음 이름(선택). collect_results에서 group으로 모아 받는다."),
      kind: { type: "string", enum: ["code", "design", "research"], description: "design이면 화면을 브라우저로 열어 스크린샷을 남기고 보고에 이미지로 붙이게 한다." },
    },
    required: ["brief"],
  }),
  leadTool({ name: "check_task", risk: "read", description: "맡긴 일의 상태(running/done/error/stopped)를 본다. task_id를 비우면 이번 턴의 모든 일.", properties: { task_id: str("delegate_task가 준 ID.") } }),
  leadTool({
    name: "collect_results", risk: "read",
    description: "맡긴 일의 결과를 받는다. wait=true면 끝날 때까지(최대 timeout_sec) 기다린다. 받은 결과는 다시 돌려주지 않는다.",
    properties: {
      task_ids: strings("받을 일의 ID. 비우면 아직 받지 않은 모든 일."),
      group: str("이 묶음의 일만."),
      wait: bool("끝날 때까지 기다리기 (기본 true)."),
      timeout_sec: num(`기다릴 최대 초 (기본·최대 ${LEAD_WAIT_LIMIT_SEC}).`),
    },
  }),
  leadTool({
    name: "write_skill", risk: "write",
    description: "재사용할 스킬(작업 지침 문서)을 만든다. 같은 종류의 일을 여러 번 맡길 때 브리프 대신 스킬로 남겨 delegate_task의 skills에 붙인다.",
    properties: {
      name: str("짧은 영문 소문자 이름 (예: 'api-review')."),
      description: str("언제 쓰는 스킬인지 한 줄."),
      content: str("스킬 본문(마크다운)."),
      scope: { type: "string", enum: ["lead", "project"], description: "lead: 이 담당만 (기본). project: 프로젝트 .claude/skills에 저장해 모두가 씀." },
    },
    required: ["name", "description", "content"],
  }),
  leadTool({
    name: "update_skill", risk: "write", description: "write_skill로 만든 스킬의 설명이나 본문을 고친다.",
    properties: { name: str("스킬 이름."), description: str("새 설명(선택)."), content: str("새 본문(선택)."), scope: { type: "string", enum: ["lead", "project"] } },
    required: ["name"],
  }),
  leadTool({ name: "list_skills", risk: "read", description: "이 담당이 워커 브리프에 붙일 수 있는 스킬(담당 스킬, 프로젝트 스킬)을 본다." }),
  leadTool({
    name: "schedule_create", risk: "write",
    description: "이 담당의 일정을 만든다. 정한 시각에 prompt가 이 담당의 채팅으로 온다. 대화에서 정해진 마감·점검·반복 작업이 있으면 쓴다.",
    properties: { title: str("일정 이름."), prompt: str("그때 담당에게 보낼 내용."), ...scheduleTiming }, required: ["prompt"],
  }),
  leadTool({ name: "schedule_list", risk: "read", description: "이 담당의 일정 목록(ID, 시각, 반복, 켜짐)과 지금 시각·시간대. 고치거나 지울 일정의 ID를 찾을 때." }),
  leadTool({
    name: "schedule_update", risk: "write", description: "이 담당의 일정을 고치거나 끄고 켠다(enabled).",
    properties: { id: str("일정 ID."), title: str("새 이름."), prompt: str("새 내용."), enabled: bool("켜기/끄기."), ...scheduleTiming }, required: ["id"],
  }),
  leadTool({
    name: "schedule_delete", risk: "approval", description: "이 담당의 일정을 지운다. 사용자 승인 후에 지워진다.",
    properties: { id: str("일정 ID.") }, required: ["id"], summary: (args, names) => `일정 ${names.schedule(args.id)} 삭제`,
  }),
];

const APP: AppTool[] = [
  // ----- 앱 상태 -----
  routeTool({
    name: "app_overview", risk: "read", method: "GET", route: "/api/bootstrap",
    description: "시나위 전체 모습: 설치된 에이전트 CLI(Codex/Claude/Grok)와 사용 가능 여부, 켜진 스킬, 봇, 프로젝트 그룹, 기본 폴더. 처음 무엇이 있는지 볼 때 쓴다.",
    properties: { workspace_id: workspaceArg },
    path: (args) => `/api/bootstrap${query({ workspace: args.workspace_id })}`,
  }),
  routeTool({ name: "app_status", risk: "read", method: "GET", route: "/api/health", description: "시나위 서버 상태: 버전, 실행 중인 채팅 수, 열린 앱 창 수." }),
  routeTool({ name: "get_setup_status", risk: "read", method: "GET", route: "/api/setup", description: "이 컴퓨터의 준비 상태: Node/Git/에이전트 CLI 설치 여부, macOS 권한(전체 디스크 접근 등)." }),
  routeTool({ name: "list_workspaces", risk: "read", method: "GET", route: "/api/workspaces", description: "워크스페이스(공간) 목록, 지금 워크스페이스, 공간별 기본값(폴더·팀·허용 에이전트)과 정책, 실행 중 채팅 수." }),

  // ----- 채팅(세션) -----
  routeTool({
    name: "list_sessions", risk: "read", method: "GET", route: "/api/sessions",
    description: "채팅(세션) 목록: ID, 제목, 상태(running/done/error/stopped), 에이전트, 폴더, 담당 여부. 내용은 get_session이나 get_session_summary로 본다.",
    properties: { workspace_id: str("이 워크스페이스의 채팅만. 비우면 전부."), status: str("이 상태만 (running, done, error, stopped)."), limit: num("최근 몇 개 (기본 50).") },
    path: (args) => `/api/sessions${query({ workspace: args.workspace_id })}`,
    pick: (output, args) => {
      const rows = (output as Row[]).filter((session) => !args.status || session.status === args.status)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return rows.slice(0, Math.max(1, Number(args.limit) || 50)).map(sessionRow);
    },
  }),
  routeTool({
    name: "get_session", risk: "read", method: "GET", route: "/api/sessions",
    description: "채팅 하나의 정보와 최근 메시지·이벤트(답변, 도구 실행, 오류). 무슨 말이 오갔는지 읽을 때 쓴다.",
    properties: { session_id: str("채팅 ID."), limit: num("최근 이벤트 몇 개 (기본 30, 최대 200).") }, required: ["session_id"],
    pick: (output, args) => {
      const session = (output as Row[]).find((item) => item.id === args.session_id);
      if (!session) throw new Error("세션을 찾을 수 없습니다.");
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 30));
      return { ...sessionRow(session), events: (session.events as Row[] ?? []).slice(-limit).map(eventRow) };
    },
  }),
  routeTool({
    name: "get_session_summary", risk: "read", method: "GET", route: "/api/sessions/:id/summary",
    description: "채팅 한눈에 보기: 상태, 담당의 마지막 답, 체크리스트 진행, 승인 기다리는 병합, 담당 정보.",
    properties: { session_id: str("채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/summary`,
  }),
  routeTool({
    name: "create_session", risk: "write", method: "POST", route: "/api/sessions",
    description: "새 채팅을 연다. prompt를 주면 첫 메시지로 바로 일을 시작하고, 비우면 아무것도 실행하지 않은 빈 채팅만 만든다(나중에 send_message로 보낸다). 담당(lead_id)의 새 스레드로 열면 팀·폴더는 담당 것을 쓴다. 담당 없이 열면 cwd가 필요하고, agent·workers를 비우면 워크스페이스 기본 팀(없으면 허용된 에이전트)을 쓴다. 어떤 팀이 맞을지 모르면 recommend_team을 먼저 부른다.",
    properties: {
      prompt: str("첫 메시지(할 일). 비우면 빈 채팅."),
      title: str("채팅 제목(선택). 비우면 첫 메시지에서 만든다."),
      lead_id: str("이 담당의 스레드로 연다 (list_leads의 ID)."),
      agent: agentEnum("주 에이전트. 비우면 담당 또는 워크스페이스 기본값."),
      workers: { type: "array", items: { type: "string", enum: ["claude", "codex", "grok"] }, description: "함께 일할 워커 CLI (최대 3). 비우면 담당 팀 → 워크스페이스 기본 팀 → 허용된 에이전트 순." },
      cwd: str("작업 폴더 절대 경로. lead_id가 없으면 필요."),
      model: str("모델(선택)."),
      reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "추론 강도(선택)." },
      skills: strings("붙일 스킬 이름."),
      group_id: str("넣을 프로젝트 그룹 ID."),
      workspace_id: workspaceArg,
      mode: { type: "string", enum: ["auto", "manual"], description: "auto: 앱이 메시지마다 팀을 배정. manual: 정한 팀 그대로." },
      permission_mode: { type: "string", enum: ["plan", "auto"], description: "plan: 계획만 세움. auto: 보통 권한으로 실행 (기본)." },
      auto_run: bool("끝까지 진행(체크리스트를 다 할 때까지 이어서 실행)."),
    },
    body: (args, ctx) => defined({
      prompt: opt(args.prompt), title: opt(args.title), agent: args.agent, workers: args.workers, cwd: args.cwd, model: args.model, reasoningEffort: args.reasoning_effort,
      skills: args.skills, groupId: args.group_id, workspaceId: args.workspace_id ?? ctx.workspaceId, mode: args.mode,
      // Always explicit: a chat without a mode follows the workspace's full-access switch (Orchestra.permissionModeOf).
      permissionMode: permissionMode(args.permission_mode) ?? "auto", autoRun: args.auto_run,
      steward: typeof args.lead_id === "string" && args.lead_id ? { id: args.lead_id } : undefined,
    }),
    pick: (output) => sessionRow(output as Row),
  }),
  routeTool({
    name: "send_message", risk: "write", method: "POST", route: "/api/sessions/:id/messages",
    description: "채팅에 이어서 메시지를 보낸다(다음 턴 시작). 담당 채팅이면 담당이 받는다. 결과는 get_session_summary나 get_session으로 확인한다.",
    properties: {
      session_id: str("채팅 ID."), prompt: str("보낼 메시지."), skills: strings("이번 메시지에 붙일 스킬."),
      permission_mode: { type: "string", enum: ["plan", "auto"], description: "plan: 계획만. auto: 실행 (기본)." },
    },
    required: ["session_id", "prompt"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/messages`,
    body: (args) => defined({ prompt: args.prompt, skills: args.skills, permissionMode: permissionMode(args.permission_mode) }),
    pick: (output) => sessionRow(output as Row),
  }),
  routeTool({
    name: "ask_running_session", risk: "write", method: "POST", route: "/api/sessions/:id/live",
    description: "실행 중인 채팅에 진행을 멈추지 않고 곁가지 질문을 한다(\"지금 어디까지 했어?\"). 답은 채팅에 따로 붙는다.",
    properties: { session_id: str("실행 중인 채팅 ID."), prompt: str("질문.") }, required: ["session_id", "prompt"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/live`,
    body: (args) => ({ prompt: args.prompt }),
  }),
  routeTool({
    name: "rename_session", risk: "write", method: "PATCH", route: "/api/sessions/:id",
    description: "채팅 제목을 바꾼다. 사이드바에 보이는 이름이 바뀐다.",
    properties: { session_id: str("채팅 ID."), title: str("새 제목 (100자 이내).") }, required: ["session_id", "title"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}`, body: (args) => ({ title: args.title }), pick: (output) => sessionRow(output as Row),
  }),
  routeTool({
    name: "move_session_to_group", risk: "write", method: "PATCH", route: "/api/sessions/:id/group",
    description: "채팅을 프로젝트 그룹에 넣거나(group_id) 그룹에서 뺀다(group_id 비움).",
    properties: { session_id: str("채팅 ID."), group_id: str("그룹 ID. 비우면 그룹에서 뺀다.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/group`, body: (args) => ({ groupId: opt(args.group_id) ?? null }), pick: (output) => sessionRow(output as Row),
  }),
  routeTool({
    name: "move_session_to_workspace", risk: "approval", method: "PATCH", route: "/api/sessions/:id/workspace",
    description: "채팅을 다른 워크스페이스(공간)로 옮긴다. 옮긴 채팅은 그 공간의 정책(전체 권한, 컴퓨터 조작 등)을 따르게 되므로 사용자 승인 후 옮긴다. 공간 ID는 list_workspaces.",
    properties: { session_id: str("채팅 ID."), workspace_id: str("옮길 워크스페이스 ID.") }, required: ["session_id", "workspace_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/workspace`, body: (args) => ({ workspaceId: args.workspace_id }), pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} → 워크스페이스 ${names.workspace(args.workspace_id)}로 옮김`,
  }),
  routeTool({
    name: "stop_session", risk: "approval", method: "POST", route: "/api/sessions/:id/stop",
    description: "실행 중인 채팅을 멈춘다. 진행 중인 일이 끊기므로 사용자 승인 후 멈춘다.",
    properties: { session_id: str("채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/stop`, pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 실행 멈춤`,
  }),
  routeTool({
    name: "compact_session", risk: "approval", method: "POST", route: "/api/sessions/:id/compact",
    description: "긴 채팅의 맥락을 요약으로 줄인다(이전 대화는 요약만 남음). 되돌릴 수 없어 사용자 승인 후 실행된다.",
    properties: { session_id: str("채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/compact`, pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 맥락 압축`,
  }),
  routeTool({
    name: "delete_session", risk: "approval", method: "DELETE", route: "/api/sessions/:id",
    description: "채팅을 지운다(실행 중이면 안 됨). remove_worktrees면 워커 worktree도 정리한다(커밋 안 된 변경이 있으면 남김). 사용자 승인 후 지워진다.",
    properties: { session_id: str("채팅 ID."), remove_worktrees: bool("워커 worktree도 지우기.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}${query({ worktrees: args.remove_worktrees === true ? "remove" : undefined })}`,
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 삭제${args.remove_worktrees === true ? " (worktree 포함)" : ""}`,
  }),
  routeTool({
    name: "set_session_team", risk: "approval", method: "PATCH", route: "/api/sessions/:id/team",
    description: "채팅의 팀(주 에이전트, 모델, 워커)을 바꾼다. 실행 중에는 안 된다. 사용자 승인 후 바뀐다.",
    properties: {
      session_id: str("채팅 ID."), agent: agentEnum("주 에이전트."), model: str("모델(선택)."),
      reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
      workers: { type: "array", items: { type: "string", enum: ["claude", "codex", "grok"] }, description: "워커 CLI (최대 3). 비우면 워커 없이 주 에이전트만." },
    },
    required: ["session_id", "agent"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/team`,
    body: (args) => defined({ agent: args.agent, model: args.model, reasoningEffort: args.reasoning_effort, workers: args.workers ?? [] }),
    pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 팀 변경 → ${String(args.agent)}${Array.isArray(args.workers) && args.workers.length ? ` + ${args.workers.join(", ")}` : ""}`,
  }),
  routeTool({
    name: "set_session_auto_switch", risk: "approval", method: "PATCH", route: "/api/sessions/:id/auto-switch",
    description: "채팅의 자동 전환(메시지마다 맞는 에이전트로 바꾸기)을 켜거나 끈다. 설정 변경이라 사용자 승인 후 적용된다.",
    properties: { session_id: str("채팅 ID."), enabled: bool("켜기/끄기.") }, required: ["session_id", "enabled"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/auto-switch`, body: (args) => ({ enabled: args.enabled }), pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 자동 전환 ${args.enabled ? "켜기" : "끄기"}`,
  }),
  routeTool({
    name: "remove_session_worker", risk: "approval", method: "DELETE", route: "/api/sessions/:id/workers/:workerId",
    description: "채팅 팀에서 워커 하나를 뺀다(그 워커의 대화 기록도 빠짐). 사용자 승인 후 실행된다.",
    properties: { session_id: str("채팅 ID."), worker_id: str("워커 ID (예: 'codex').") }, required: ["session_id", "worker_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/workers/${seg(args, "worker_id")}`, pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)}에서 워커 ${String(args.worker_id)} 빼기`,
  }),
  routeTool({
    name: "list_worktrees", risk: "read", method: "GET", route: "/api/sessions/:id/worktrees",
    description: "채팅의 워커별 git worktree와 상태(브랜치, 커밋 수, 커밋 안 된 변경).",
    properties: { session_id: str("채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/worktrees`,
  }),
  routeTool({
    name: "delete_worktree", risk: "approval", method: "DELETE", route: "/api/sessions/:id/worktrees/:workerId",
    description: "워커의 git worktree를 지운다. force면 커밋 안 된 변경도 버린다. 사용자 승인 후 지워진다.",
    properties: { session_id: str("채팅 ID."), worker_id: str("워커 ID."), force: bool("커밋 안 된 변경도 버리기.") }, required: ["session_id", "worker_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/worktrees/${seg(args, "worker_id")}${query({ force: args.force === true ? "1" : undefined })}`,
    summary: (args, names) => `채팅 ${names.session(args.session_id)}의 ${String(args.worker_id)} worktree 삭제${args.force === true ? " (변경 버림)" : ""}`,
  }),

  // ----- 병합 -----
  routeTool({
    name: "approve_merge", risk: "approval", method: "POST", route: "/api/sessions/:id/merge/approve",
    description: "담당 채팅에서 승인을 기다리는 워커 브랜치 병합을 승인해 프로젝트에 합친다. 되돌리기 어려워 사용자 승인 후 병합된다. 무엇이 기다리는지는 get_session_summary의 pendingMerge.",
    properties: { session_id: str("담당 채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/merge/approve`, pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)}의 대기 중인 병합 승인`,
  }),
  routeTool({
    name: "reject_merge", risk: "approval", method: "POST", route: "/api/sessions/:id/merge/reject",
    description: "승인을 기다리는 병합을 거절한다(브랜치는 합쳐지지 않음). 사용자 승인 후 실행된다.",
    properties: { session_id: str("담당 채팅 ID.") }, required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/merge/reject`, pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)}의 대기 중인 병합 거절`,
  }),

  // ----- 담당(프로젝트 리드) -----
  routeTool({ name: "list_leads", risk: "read", method: "GET", route: "/api/stewards", description: "프로젝트 담당 목록: 이름, 팀, 병합 정책(auto/ask/never), 폴더, 일일 보고 시각." }),
  routeTool({
    name: "get_lead", risk: "read", method: "GET", route: "/api/stewards/:id",
    description: "담당 하나의 설정, 노트(담당이 기억하는 것), 스레드(채팅) 목록.",
    properties: { lead_id: str("담당 ID.") }, required: ["lead_id"], path: (args) => `/api/stewards/${seg(args, "lead_id")}`,
  }),
  routeTool({
    name: "create_lead", risk: "write", method: "POST", route: "/api/stewards",
    description: "프로젝트 담당을 만든다. 담당은 폴더(cwds)를 맡아 워커에게 일을 나누고 결과를 합친다. 병합 정책은 ask(기본, 병합 전에 사용자에게 물음) 또는 never만 정할 수 있다. auto는 update_lead로(승인 필요).",
    properties: {
      name: str("담당 이름 (고유)."), agent: agentEnum("담당 자신의 CLI."), model: str("모델(선택)."),
      system_prompt: str("담당 지침."), skills: strings("담당 스킬."),
      workers: { type: "array", items: { type: "object", properties: { agent: agentEnum("워커 CLI."), model: str("모델.") }, required: ["agent"] }, description: "담당의 워커들." },
      merge_policy: { type: "string", enum: ["ask", "never"], description: "ask: 병합 전에 물음 (기본). never: 병합 안 함." },
      cwds: strings("맡을 프로젝트 폴더 절대 경로."), report: str("일일 보고 시각 HH:MM (선택)."),
    },
    required: ["name"],
    body: (args) => {
      if (args.merge_policy !== undefined && args.merge_policy !== "ask" && args.merge_policy !== "never") throw new Error("새 담당의 merge_policy는 ask 또는 never입니다. auto는 update_lead로 바꾸세요(사용자 승인 필요).");
      return defined({ name: args.name, agent: args.agent, model: args.model, systemPrompt: args.system_prompt, skills: args.skills, workers: workerSelections(args.workers), mergePolicy: args.merge_policy, cwds: args.cwds, report: args.report });
    },
  }),
  routeTool({
    name: "update_lead", risk: "approval", method: "PATCH", route: "/api/stewards/:id",
    description: "담당 설정(이름, 지침, 팀, 병합 정책, 폴더, 노트, 보고 시각)을 바꾼다. 준 값만 바뀐다. 사용자 승인 후 적용된다.",
    properties: {
      lead_id: str("담당 ID."), name: str("새 이름."), agent: agentEnum("담당 CLI."), model: str("모델."),
      reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
      system_prompt: str("담당 지침."), skills: strings("담당 스킬."),
      workers: { type: "array", items: { type: "object", properties: { agent: agentEnum("워커 CLI."), model: str("모델.") }, required: ["agent"] } },
      merge_policy: { type: "string", enum: ["auto", "ask", "never"], description: "auto: 검증되면 바로 병합. ask: 병합 전에 물음. never: 병합 안 함." },
      cwds: strings("맡을 폴더."), notes: str("담당 노트 전체(덮어씀)."), report: str("일일 보고 시각 HH:MM. 빈 문자열이면 끔."),
    },
    required: ["lead_id"],
    path: (args) => `/api/stewards/${seg(args, "lead_id")}`,
    body: (args) => defined({ name: args.name, agent: args.agent, model: args.model, reasoningEffort: args.reasoning_effort, systemPrompt: args.system_prompt, skills: args.skills, workers: workerSelections(args.workers), mergePolicy: args.merge_policy, cwds: args.cwds, notes: args.notes, report: args.report }),
    summary: (args, names) => `담당 ${names.lead(args.lead_id)} 설정 변경: ${Object.keys(args).filter((key) => key !== "lead_id").join(", ") || "(없음)"}`,
  }),
  routeTool({
    name: "delete_lead", risk: "approval", method: "DELETE", route: "/api/stewards/:id",
    description: "담당을 지운다. 그 담당의 채팅은 보통 채팅으로 남는다. 사용자 승인 후 지워진다.",
    properties: { lead_id: str("담당 ID.") }, required: ["lead_id"], path: (args) => `/api/stewards/${seg(args, "lead_id")}`,
    summary: (args, names) => `담당 ${names.lead(args.lead_id)} 삭제`,
  }),
  routeTool({
    name: "get_session_lead", risk: "read", method: "GET", route: "/api/sessions/:id/steward",
    description: "담당 채팅의 담당 상태: 담당, 노트, 대기 병합, 턴 수, 보고 시각, 다른 담당 목록.",
    properties: { session_id: str("담당 채팅 ID.") }, required: ["session_id"], path: (args) => `/api/sessions/${seg(args, "session_id")}/steward`,
  }),
  routeTool({
    name: "update_session_lead", risk: "approval", method: "PATCH", route: "/api/sessions/:id/steward",
    description: "채팅의 담당 모드를 켜고 끄거나, 이름·보고 시각·'다른 담당의 부탁으로 작업하기'(accept_work)를 바꾼다. 사용자 승인 후 적용된다.",
    properties: { session_id: str("채팅 ID."), enabled: bool("담당 모드."), name: str("담당 이름."), report: str("보고 시각 HH:MM, 빈 문자열이면 끔."), accept_work: bool("다른 담당의 부탁으로 작업하기.") },
    required: ["session_id"],
    path: (args) => `/api/sessions/${seg(args, "session_id")}/steward`,
    body: (args) => defined({ enabled: args.enabled, name: args.name, report: args.report, acceptWork: args.accept_work }),
    pick: (output) => sessionRow(output as Row),
    summary: (args, names) => `채팅 ${names.session(args.session_id)} 담당 설정 변경: ${Object.keys(args).filter((key) => key !== "session_id").join(", ")}`,
  }),
  routeTool({ name: "get_lead_settings", risk: "read", method: "GET", route: "/api/stewards/settings", description: "앱 전체 담당 설정: 이전된 담당이 받는 기본 병합 정책." }),
  routeTool({
    name: "set_legacy_merge_policy", risk: "approval", method: "PUT", route: "/api/stewards/settings",
    description: "이전된(옛 방식) 담당들의 기본 병합 정책을 auto/ask로 정한다. 사용자 승인 후 적용된다.",
    properties: { policy: { type: "string", enum: ["auto", "ask"] } }, required: ["policy"], body: (args) => ({ legacyMergePolicy: args.policy }),
    summary: (args) => `이전된 담당의 병합 정책 → ${String(args.policy)}`,
  }),
  routeTool({
    name: "set_all_merge_policies", risk: "approval", method: "POST", route: "/api/stewards/merge-policy/bulk",
    description: "모든 담당의 병합 정책을 한 번에 바꾼다. 사용자 승인 후 적용된다.",
    properties: { policy: { type: "string", enum: ["auto", "ask", "never"] } }, required: ["policy"], body: (args) => ({ policy: args.policy }),
    summary: (args) => `모든 담당의 병합 정책 → ${String(args.policy)}`,
  }),

  // ----- 일정 (외부 표면; 담당은 자기 schedule_* 도구를 쓴다) -----
  routeTool({
    name: "list_lead_schedules", risk: "read", method: "GET", route: "/api/stewards/:id/schedules", surfaces: ["external"],
    description: "담당의 일정 목록(정한 시각에 담당 채팅으로 메시지가 감).",
    properties: { lead_id: str("담당 ID.") }, required: ["lead_id"], path: (args) => `/api/stewards/${seg(args, "lead_id")}/schedules`,
  }),
  routeTool({
    name: "create_lead_schedule", risk: "write", method: "POST", route: "/api/stewards/:id/schedules", surfaces: ["external"],
    description: "담당에게 일정을 만든다. at(한 번) 또는 cron(반복) 중 하나. 그 시각에 prompt가 담당 채팅으로 간다.",
    properties: { lead_id: str("담당 ID."), title: str("일정 이름."), prompt: str("그때 보낼 내용."), ...scheduleTiming }, required: ["lead_id", "prompt"],
    path: (args) => `/api/stewards/${seg(args, "lead_id")}/schedules`,
    body: (args) => defined({ title: args.title, prompt: args.prompt, at: args.at, cron: args.cron, timezone: args.timezone }),
  }),
  routeTool({
    name: "update_lead_schedule", risk: "write", method: "PATCH", route: "/api/schedules/:id", surfaces: ["external"],
    description: "담당의 일정을 고치거나 끄고 켠다(enabled). 준 값만 바뀐다.",
    properties: { schedule_id: str("일정 ID."), title: str("새 이름."), prompt: str("새 내용."), enabled: bool("켜기/끄기."), ...scheduleTiming }, required: ["schedule_id"],
    path: (args) => `/api/schedules/${seg(args, "schedule_id")}`,
    body: (args) => defined({ title: args.title, prompt: args.prompt, at: args.at, cron: args.cron, timezone: args.timezone, enabled: args.enabled }),
  }),
  routeTool({
    name: "delete_lead_schedule", risk: "approval", method: "DELETE", route: "/api/schedules/:id", surfaces: ["external"],
    description: "담당의 일정을 지운다. 끄기만 하려면 update_lead_schedule(enabled:false). 사용자 승인 후 지워진다.",
    properties: { schedule_id: str("일정 ID.") }, required: ["schedule_id"], path: (args) => `/api/schedules/${seg(args, "schedule_id")}`,
    summary: (args, names) => `일정 ${names.schedule(args.schedule_id)} 삭제`,
  }),

  // ----- 사용자 선호 -----
  routeTool({ name: "get_user_preferences", risk: "read", method: "GET", route: "/api/user-preferences", description: "모든 담당이 읽는 사용자 선호(user-preferences.md): 말투, 작업 방식, 하지 말 것." }),
  routeTool({
    name: "set_user_preferences", risk: "approval", method: "PUT", route: "/api/user-preferences",
    description: "사용자 선호 전체를 새 글로 바꾼다(덮어씀). get_user_preferences로 읽고 고쳐서 보낸다. 사용자 승인 후 저장된다.",
    properties: { text: str("선호 전체 (마크다운).") }, required: ["text"], body: (args) => ({ text: args.text }),
    summary: (args) => `사용자 선호 덮어쓰기 (${String(args.text ?? "").length}자)`,
  }),

  // ----- 워크스페이스 -----
  routeTool({
    name: "create_workspace", risk: "write", method: "POST", route: "/api/workspaces",
    description: "워크스페이스(공간)를 만든다. 지금 공간의 기본값과 정책을 이어받는다.",
    properties: { name: str("이름 (1~40자).") }, required: ["name"], body: (args) => ({ name: args.name }),
  }),
  routeTool({
    name: "rename_workspace", risk: "write", method: "PATCH", route: "/api/workspaces/:id",
    description: "워크스페이스(공간) 이름을 바꾼다. 기본값·정책은 update_workspace_settings.",
    properties: { workspace_id: str("워크스페이스 ID."), name: str("새 이름 (1~40자).") }, required: ["workspace_id", "name"],
    path: (args) => `/api/workspaces/${seg(args, "workspace_id")}`, body: (args) => ({ name: args.name }),
  }),
  routeTool({
    name: "switch_workspace", risk: "approval", method: "PATCH", route: "/api/workspaces",
    description: "앱에서 지금 보는 워크스페이스를 바꾼다. 사용자 화면이 바뀌므로 승인 후 적용된다.",
    properties: { workspace_id: str("워크스페이스 ID.") }, required: ["workspace_id"], body: (args) => ({ currentWorkspaceId: args.workspace_id }),
    summary: (args, names) => `지금 워크스페이스 → ${names.workspace(args.workspace_id)}`,
  }),
  routeTool({
    name: "update_workspace_settings", risk: "approval", method: "PATCH", route: "/api/workspaces",
    description: "워크스페이스의 기본값(defaults: 폴더 cwd, 팀 agent/workers, 허용 에이전트 allowedAgents, 한도 자동 전환 quotaFallback 등 — 통째로 바뀜)이나 정책(policy: 미디어 생성, 컴퓨터 조작, 전체 권한, 차단 도구 등 — 준 값만 합쳐짐)을 바꾼다. list_workspaces로 지금 값을 읽고 고쳐서 보낸다. 사용자 승인 후 적용된다.",
    properties: { workspace_id: str("워크스페이스 ID."), defaults: { type: "object", description: "공간 기본값 전체." }, policy: { type: "object", description: "바꿀 정책 항목." } },
    required: ["workspace_id"],
    body: (args) => {
      if (args.defaults === undefined && args.policy === undefined) throw new Error("defaults나 policy 중 하나는 있어야 합니다.");
      return defined({ workspaceId: args.workspace_id, defaults: args.defaults, settings: args.policy });
    },
    summary: (args, names) => `워크스페이스 ${names.workspace(args.workspace_id)} ${[args.defaults !== undefined ? "기본값" : "", args.policy !== undefined ? "정책" : ""].filter(Boolean).join("·")} 변경`,
  }),
  routeTool({
    name: "delete_workspace", risk: "approval", method: "DELETE", route: "/api/workspaces/:id",
    description: "워크스페이스를 지운다. 그 안의 채팅과 그룹은 move_to(비우면 남은 첫 공간)로 옮겨진다. 실행 중인 채팅이 있으면 안 된다. 사용자 승인 후 지워진다.",
    properties: { workspace_id: str("지울 워크스페이스 ID."), move_to: str("내용을 옮길 워크스페이스 ID.") }, required: ["workspace_id"],
    path: (args) => `/api/workspaces/${seg(args, "workspace_id")}${query({ moveTo: args.move_to })}`,
    summary: (args, names) => `워크스페이스 ${names.workspace(args.workspace_id)} 삭제${args.move_to ? ` (내용 → ${names.workspace(args.move_to)})` : ""}`,
  }),

  // ----- 프로젝트 그룹 -----
  routeTool({
    name: "list_groups", risk: "read", method: "GET", route: "/api/groups", description: "프로젝트 그룹(사이드바에서 채팅을 묶는 폴더) 목록: ID, 이름, 워크스페이스.",
    properties: { workspace_id: str("이 워크스페이스의 그룹만. 비우면 전부.") }, path: (args) => `/api/groups${query({ workspace: args.workspace_id })}`,
  }),
  routeTool({
    name: "create_group", risk: "write", method: "POST", route: "/api/groups", description: "프로젝트 그룹(채팅 묶음)을 만든다. 채팅은 move_session_to_group으로 넣는다.",
    properties: { name: str("그룹 이름."), workspace_id: workspaceArg }, required: ["name"],
    body: (args, ctx) => defined({ name: args.name, workspaceId: args.workspace_id ?? ctx.workspaceId }),
  }),
  routeTool({
    name: "rename_group", risk: "write", method: "PATCH", route: "/api/groups/:id", description: "프로젝트 그룹(채팅 묶음)의 이름을 바꾼다. 같은 공간에서 이름은 겹칠 수 없다.",
    properties: { group_id: str("그룹 ID."), name: str("새 이름.") }, required: ["group_id", "name"],
    path: (args) => `/api/groups/${seg(args, "group_id")}`, body: (args) => ({ name: args.name }),
  }),
  routeTool({
    name: "move_group_to_workspace", risk: "approval", method: "PATCH", route: "/api/groups/:id/workspace", description: "프로젝트 그룹을 안의 채팅과 함께 다른 워크스페이스로 옮긴다. 옮긴 채팅은 그 공간의 정책(전체 권한, 컴퓨터 조작 등)을 따르게 되므로 사용자 승인 후 옮긴다.",
    properties: { group_id: str("그룹 ID."), workspace_id: str("옮길 워크스페이스 ID.") }, required: ["group_id", "workspace_id"],
    path: (args) => `/api/groups/${seg(args, "group_id")}/workspace`, body: (args) => ({ workspaceId: args.workspace_id }),
    summary: (args, names) => `그룹 ${names.group(args.group_id)} → 워크스페이스 ${names.workspace(args.workspace_id)}로 옮김`,
  }),
  routeTool({
    name: "delete_group", risk: "approval", method: "DELETE", route: "/api/groups/:id", description: "프로젝트 그룹을 지운다(채팅은 그룹 밖으로 남음). 사용자 승인 후 지워진다.",
    properties: { group_id: str("그룹 ID.") }, required: ["group_id"], path: (args) => `/api/groups/${seg(args, "group_id")}`,
    summary: (args, names) => `그룹 ${names.group(args.group_id)} 삭제`,
  }),

  // ----- 봇 -----
  routeTool({
    name: "create_bot", risk: "write", method: "POST", route: "/api/bots", description: "봇(이름·에이전트·지침을 가진 캐릭터)을 만든다. 봇끼리 대화는 start_bot_conversation. 목록은 app_overview의 bots.",
    properties: { name: str("봇 이름."), agent: agentEnum("봇의 CLI."), model: str("모델."), system_prompt: str("봇 지침."), skills: strings("스킬.") }, required: ["name", "agent"],
    body: (args) => defined({ name: args.name, agent: args.agent, model: args.model, systemPrompt: args.system_prompt, skills: args.skills }),
  }),
  routeTool({
    name: "delete_bot", risk: "approval", method: "DELETE", route: "/api/bots/:id", description: "봇(이름·지침을 가진 캐릭터)을 지운다. 사용자 승인 후 지워진다.",
    properties: { bot_id: str("봇 ID.") }, required: ["bot_id"], path: (args) => `/api/bots/${seg(args, "bot_id")}`,
    summary: (args, names) => `봇 ${names.bot(args.bot_id)} 삭제`,
  }),
  routeTool({
    name: "start_bot_conversation", risk: "write", method: "POST", route: "/api/conversations", description: "두 봇이 주제를 두고 정한 턴만큼 대화하는 채팅을 연다.",
    properties: { bot_a: str("봇 A ID."), bot_b: str("봇 B ID."), prompt: str("주제."), turns: num("턴 수 (1~20)."), cwd: str("작업 폴더."), workspace_id: workspaceArg },
    required: ["bot_a", "bot_b", "prompt", "turns", "cwd"],
    body: (args, ctx) => defined({ botA: args.bot_a, botB: args.bot_b, prompt: args.prompt, turns: args.turns, cwd: args.cwd, workspaceId: args.workspace_id ?? ctx.workspaceId, permissionMode: "auto" }),
    pick: (output) => sessionRow(output as Row),
  }),

  // ----- 알림 -----
  routeTool({
    name: "list_notifications", risk: "read", method: "GET", route: "/api/notifications", description: "앱 알림(로그인 필요, 한도, 권한 질문, 작업 완료, 담당 보고, 오류).",
    properties: { workspace_id: workspaceArg }, path: (args, ctx) => `/api/notifications${query({ workspace: args.workspace_id ?? ctx.workspaceId })}`,
  }),
  routeTool({
    name: "notify_user", risk: "write", method: "POST", route: "/api/notifications", description: "사용자에게 앱 알림(안내)을 띄운다. 끝난 일, 확인이 필요한 일을 알릴 때.",
    properties: { title: str("제목 (200자 이내)."), body: str("내용."), workspace_id: workspaceArg }, required: ["title"],
    body: (args, ctx) => defined({ type: "info", title: args.title, body: args.body, workspace: args.workspace_id ?? ctx.workspaceId }),
  }),
  routeTool({
    name: "mark_notifications_read", risk: "write", method: "POST", route: "/api/notifications/read", description: "알림을 읽음으로 표시한다(ids 또는 all).",
    properties: { ids: strings("알림 ID."), all: bool("모두 읽음."), workspace_id: workspaceArg },
    body: (args, ctx) => defined({ ids: args.ids, all: args.all, workspace: args.workspace_id ?? ctx.workspaceId }),
  }),
  routeTool({
    name: "clear_notifications", risk: "approval", method: "DELETE", route: "/api/notifications", description: "워크스페이스의 알림을 모두 지운다. 사용자 승인 후 지워진다.",
    properties: { workspace_id: workspaceArg }, path: (args, ctx) => `/api/notifications${query({ workspace: args.workspace_id ?? ctx.workspaceId })}`,
    summary: (args, names) => `알림 모두 지우기${args.workspace_id ? ` (${names.workspace(args.workspace_id)})` : ""}`,
  }),

  // ----- 스킬·도구 -----
  routeTool({
    name: "list_installed_skills", risk: "read", method: "GET", route: "/api/skills", description: "폴더 기준으로 쓸 수 있는(켜진) 스킬 목록: 이름, 설명, 출처.",
    properties: { cwd: str("기준 폴더(프로젝트 스킬 포함). 비우면 앱 폴더."), workspace_id: workspaceArg },
    path: (args, ctx) => `/api/skills${query({ cwd: args.cwd, workspace: args.workspace_id ?? ctx.workspaceId })}`,
  }),
  routeTool({
    name: "refresh_skills", risk: "read", method: "POST", route: "/api/skills/refresh", description: "스킬을 디스크에서 다시 읽는다(새로 설치한 스킬이 안 보일 때).",
    properties: { cwd: str("기준 폴더."), workspace_id: workspaceArg }, required: ["cwd"],
    body: (args, ctx) => defined({ cwd: args.cwd, workspace: args.workspace_id ?? ctx.workspaceId }),
  }),
  routeTool({
    name: "list_tools", risk: "read", method: "GET", route: "/api/tools", description: "에이전트별 MCP 도구와 스킬, 켜짐 여부와 인증 필요 여부(도구 관리 화면).",
    properties: { cwd: str("기준 폴더."), workspace_id: workspaceArg },
    path: (args, ctx) => `/api/tools${query({ cwd: args.cwd, workspace: args.workspace_id ?? ctx.workspaceId })}`,
    // The screen shows each server's command line / URL; those can carry API keys, so an AI does not get them.
    pick: (output) => withoutLaunchDetails(output),
  }),
  routeTool({
    name: "set_mcp_tool_enabled", risk: "approval", method: "PUT", route: "/api/tools/mcp", description: "에이전트의 MCP 서버를 이 워크스페이스에서 켜거나 끈다(CLI 설정도 바뀜). 사용자 승인 후 적용된다.",
    properties: { agent: agentEnum("에이전트."), name: str("MCP 서버 이름."), enabled: bool("켜기/끄기."), workspace_id: workspaceArg }, required: ["agent", "name", "enabled"],
    body: (args, ctx) => defined({ agent: args.agent, name: args.name, enabled: args.enabled, workspace: args.workspace_id ?? ctx.workspaceId }),
    summary: (args) => `${String(args.agent)} MCP '${String(args.name)}' ${args.enabled ? "켜기" : "끄기"}`,
  }),
  routeTool({
    name: "set_skill_enabled", risk: "approval", method: "PUT", route: "/api/tools/skill", description: "스킬을 이 워크스페이스에서 켜거나 끈다. 사용자 승인 후 적용된다.",
    properties: { name: str("스킬 이름."), enabled: bool("켜기/끄기."), workspace_id: workspaceArg }, required: ["name", "enabled"],
    body: (args, ctx) => defined({ name: args.name, enabled: args.enabled, workspace: args.workspace_id ?? ctx.workspaceId }),
    summary: (args) => `스킬 '${String(args.name)}' ${args.enabled ? "켜기" : "끄기"}`,
  }),

  // ----- 설정·배정 -----
  routeTool({ name: "get_settings", risk: "read", method: "GET", route: "/api/settings", description: "배정(라우팅) 설정: 분석 모델, 에이전트별 모델 목록과 로그인 상태, 배정 규칙." }),
  routeTool({ name: "refresh_models", risk: "read", method: "POST", route: "/api/settings/models/refresh", description: "에이전트 CLI의 모델 목록과 로그인 상태를 다시 확인한다." }),
  routeTool({
    name: "update_routing_settings", risk: "approval", method: "PUT", route: "/api/settings",
    description: "배정 설정 전체를 저장한다. get_settings로 읽은 객체를 고쳐서 settings로 보낸다. 사용자 승인 후 저장된다.",
    properties: { settings: { type: "object", description: "배정 설정 전체." } }, required: ["settings"], body: (args) => args.settings,
    summary: () => "배정(라우팅) 설정 저장",
  }),
  routeTool({
    name: "recommend_team", risk: "read", method: "POST", route: "/api/route",
    description: "할 일에 맞는 팀(주 에이전트, 워커, 모델)을 앱의 분석기로 추천받는다. create_session 전에 쓴다.",
    properties: { prompt: str("할 일."), cwd: str("작업 폴더."), skills: strings("붙일 스킬."), workspace_id: workspaceArg }, required: ["prompt", "cwd"],
    body: (args, ctx) => defined({ prompt: args.prompt, cwd: args.cwd, skills: args.skills, workspaceId: args.workspace_id ?? ctx.workspaceId }),
  }),

  // ----- 사용량·한도 -----
  routeTool({
    name: "get_usage", risk: "read", method: "GET", route: "/api/usage", description: "최근 실행별 토큰·비용 사용량(에이전트, 모델, 채팅, 역할별). 비용이나 많이 쓴 곳을 볼 때.",
    properties: { limit: num("최근 몇 건 (기본 50).") },
    pick: (output, args) => { const runs = ((output as Row).runs ?? []) as Row[]; return { total: runs.length, runs: runs.slice(-Math.max(1, Number(args.limit) || 50)) }; },
  }),
  routeTool({ name: "get_limits", risk: "read", method: "GET", route: "/api/limits", description: "에이전트별 사용 한도(남은 비율, 초기화 시각)." }),
  routeTool({ name: "refresh_limits", risk: "read", method: "POST", route: "/api/limits/refresh", description: "Claude 사용 한도를 지금 다시 확인한다." }),

  // ----- 파일·폴더 -----
  routeTool({
    name: "search_files", risk: "read", method: "GET", route: "/api/files", description: "폴더 안 파일을 이름으로 찾는다(.gitignore 따름).",
    properties: { cwd: str("찾을 폴더."), q: str("검색어.") }, required: ["cwd"], path: (args) => `/api/files${query({ cwd: args.cwd, q: args.q })}`,
  }),
  routeTool({
    name: "list_directories", risk: "read", method: "GET", route: "/api/directories", description: "폴더 안 하위 폴더 목록(작업 폴더 고를 때).",
    properties: { path: str("폴더 경로 (~/ 가능). 비우면 홈.") }, path: (args) => `/api/directories${query({ path: args.path })}`,
  }),

  // ----- 환경 -----
  routeTool({ name: "list_permission_requests", risk: "read", method: "GET", route: "/api/permissions", description: "실행 중인 에이전트가 사용자 답을 기다리는 권한 질문 목록(답은 사용자가 앱에서 함).", properties: { workspace_id: str("이 워크스페이스만.") }, path: (args) => `/api/permissions${query({ workspaceId: args.workspace_id })}` }),
  routeTool({ name: "computer_use_status", risk: "read", method: "GET", route: "/api/computer/state", description: "컴퓨터 조작 상태: 허락된 채팅, 진행 중인 조작." }),
  routeTool({
    name: "stop_computer_use", risk: "write", method: "POST", route: "/api/computer/stop", description: "진행 중인 컴퓨터 조작(마우스·키보드)을 모두 멈춘다. 안전을 위한 멈춤이라 바로 실행된다.",
    properties: { reason: str("멈추는 이유 (짧게).") }, body: (args) => ({ reason: typeof args.reason === "string" && args.reason ? args.reason : "ai" }),
  }),
  routeTool({ name: "list_preview_ports", risk: "read", method: "GET", route: "/api/preview/ports", description: "이 컴퓨터에서 열려 있는 개발 서버 포트(미리보기 대상)." }),
  routeTool({ name: "list_simulators", risk: "read", method: "GET", route: "/api/sim-view/devices", description: "이 Mac의 iOS 시뮬레이터 기기 목록(UDID, 이름, 켜짐 여부)." }),
  routeTool({ name: "list_terminals", risk: "read", method: "GET", route: "/api/terminal", description: "앱의 통합 터미널 목록(ID, 폴더, 실행 중 여부). run_in_terminal에 줄 ID를 찾을 때." }),
  routeTool({
    name: "run_in_terminal", risk: "approval", method: "POST", route: "/api/terminal/:id/run", description: "앱 통합 터미널에서 명령을 실행한다. 임의 명령이라 사용자 승인 후 실행된다.",
    properties: { terminal_id: str("터미널 ID (list_terminals)."), command: str("실행할 명령.") }, required: ["terminal_id", "command"],
    path: (args) => `/api/terminal/${seg(args, "terminal_id")}/run`, body: (args) => ({ command: args.command }),
    summary: (args) => `터미널 ${String(args.terminal_id)}에서 실행: ${String(args.command)}`,
  }),
  routeTool({
    name: "close_terminal", risk: "approval", method: "DELETE", route: "/api/terminal/:id", description: "통합 터미널을 닫는다(그 안의 프로세스도 끝남). 사용자 승인 후 닫힌다.",
    properties: { terminal_id: str("터미널 ID.") }, required: ["terminal_id"], path: (args) => `/api/terminal/${seg(args, "terminal_id")}`,
    summary: (args) => `터미널 ${String(args.terminal_id)} 닫기`,
  }),

  // ----- 승인 -----
  routeTool({
    name: "list_approvals", risk: "read", method: "GET", route: "/api/app-approvals",
    description: "승인 요청 목록과 결과. 승인이 필요한 도구가 준 approvalId로 상태(pending/approved/rejected/failed)와 실행 결과를 확인한다.",
    properties: { approval_id: str("이 요청만."), status: { type: "string", enum: ["pending", "approved", "rejected", "failed"] } },
    path: (args) => `/api/app-approvals${query({ id: args.approval_id, status: args.status })}`,
  }),
];

export const APP_TOOLS: AppTool[] = [...LEAD_ONLY, ...APP];
/** Lead-only tool names (they need the lead's live turn), for tests and docs. */
export const LEAD_TOOL_NAMES = LEAD_ONLY.map((tool) => tool.name);

export function toolsFor(surface: ToolSurface): AppTool[] {
  return APP_TOOLS.filter((tool) => tool.surfaces.includes(surface));
}

export function findTool(surface: ToolSurface, name: string): AppTool | undefined {
  return APP_TOOLS.find((tool) => tool.name === name && tool.surfaces.includes(surface));
}

/** What tools/list shows for one tool: MCP annotations tell the AI which ones change or remove things. */
export function listedTool(tool: AppTool) {
  const approval = tool.risk === "approval";
  return {
    name: tool.name,
    description: approval ? `${tool.description} [승인 필요: 바로 실행되지 않고 {status:"pending_approval", approvalId}를 돌려준다]` : tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.risk === "read", destructiveHint: approval, openWorldHint: false },
  };
}

/**
 * Routes that have no tool, each with the reason. The coverage test compares tools + these against
 * the routes the real server registers, so a new route fails the test until it gets one or the other.
 */
export const ROUTE_EXCLUSIONS: Record<string, string> = {
  "POST /api/lead-mcp": "MCP 엔드포인트 자체(담당 실행의 sinawi_lead).",
  "POST /api/app-mcp": "MCP 엔드포인트 자체(외부 AI용 sinawi-mcp).",
  "GET /api/app-mcp/connection": "외부 연결 토큰을 보여 주는 설정 화면용. AI에게 토큰을 주지 않는다.",
  "POST /api/app-mcp/token": "외부 연결 토큰 재발급(설정 화면 버튼). AI가 자기 연결을 바꾸면 안 된다.",
  "POST /api/app-approvals/:id/approve": "사용자만 하는 결정. AI가 자기 승인 요청을 승인하면 승인의 의미가 없다.",
  "POST /api/app-approvals/:id/reject": "사용자만 하는 결정(승인 카드의 거절 버튼).",
  "POST /api/permissions/request": "Claude 실행 내부의 권한 질문 MCP가 실행 토큰으로 부르는 경로.",
  "POST /api/permissions/:id/answer": "권한 질문에 대한 사용자의 답. AI가 대신 답하면 안 된다.",
  "POST /api/browser/result": "앱 창이 브라우저 명령 결과를 돌려주는 내부 경로.",
  "POST /api/browser/:action": "실행 토큰이 필요한 앱 브라우저 브리지. 에이전트는 orchestra-browser 스킬(ao-browser)로 쓴다.",
  "POST /api/computer/result": "앱 창이 컴퓨터 조작 결과를 돌려주는 내부 경로.",
  "POST /api/computer/revoke": "사용자가 컴퓨터 조작 허락을 거두는 버튼. AI가 허락 상태를 바꾸지 않는다.",
  "GET /api/computer/activity": "컴퓨터 조작 기록 화면용. 요약은 computer_use_status.",
  "GET /api/computer/image/:name": "조작 스크린샷 이미지 파일(바이너리).",
  "POST /api/computer/:action": "실행 토큰과 macOS 승인 창이 필요한 컴퓨터 조작. 에이전트는 orchestra-computer 스킬(ao-computer)로 쓴다.",
  "GET /api/link-preview": "채팅 링크 카드 렌더링 보조.",
  "POST /api/open-external": "사용자 기본 브라우저로 URL을 여는 화면 동작. AI가 임의 URL을 열지 않게 뺀다.",
  "POST /api/preview/open": "앱 미리보기 창의 프록시 열기(화면 동작).",
  "GET /api/preview/native-script": "앱 미리보기 창에 주입하는 스크립트.",
  "GET /api/preview/native-page-script": "앱 미리보기 창에 주입하는 스크립트.",
  "POST /api/preview/assets": "미리보기 화면 캡처 업로드(화면 내부).",
  "POST /api/preview/assets/raw": "미리보기 화면 캡처 업로드(바이너리).",
  "POST /api/serve/:op": "실행 토큰이 필요한 개발 서버 관리. 에이전트는 ao-serve CLI로 쓴다.",
  "POST /api/sim/:op": "실행 토큰이 필요한 시뮬레이터 조작. 에이전트는 ao-sim CLI로 쓴다.",
  "GET /api/sessions/:id/file": "채팅 첨부 파일 내용(바이너리 스트림, 화면 표시용).",
  "POST /api/sessions/:id/file/open": "Finder나 기본 앱으로 파일을 여는 화면 동작.",
  "GET /api/preview/file": "미리보기 파일 내용(바이너리, 화면 표시용).",
  "POST /api/preview/file/open": "Finder나 기본 앱으로 파일을 여는 화면 동작.",
  "POST /api/directories/pick": "Finder 폴더 선택 창(사용자가 직접 고르는 대화상자).",
  "POST /api/sessions/:id/live/promote": "곁가지 답 카드의 '채팅에 넣기' 버튼(그 카드의 이벤트 ID가 필요한 화면 동작).",
  "POST /api/sessions/:id/handoff/undo": "자동 전환 카드의 되돌리기 버튼(그 카드의 이벤트 ID가 필요한 화면 동작).",
  "POST /api/sessions/:id/quota/return": "한도 전환 배너의 '원래 에이전트로' 버튼(그 배너의 이벤트 ID가 필요한 화면 동작).",
  "POST /api/sessions/:id/worktrees/:workerId/open": "Finder로 worktree 폴더를 여는 화면 동작.",
  "POST /api/setup/open-settings": "macOS 시스템 설정 창을 여는 화면 동작.",
  "POST /api/sim-view/boot": "시뮬레이터 창 화면 스트림(화면 동작).",
  "GET /api/sim-view/frame": "시뮬레이터 화면 프레임(바이너리 스트림).",
  "POST /api/sim-view/capture": "시뮬레이터 창 캡처(화면 동작).",
  "POST /api/sim-view/input": "시뮬레이터 창의 마우스 입력(화면 동작). 에이전트는 ao-sim으로 조작한다.",
  "POST /api/terminal/external": "macOS Terminal.app을 여는 화면 동작.",
  "GET /health": "/api/health와 같은 내용(app_status).",
  "GET /{*path}": "앱 화면(정적 파일).",
};

// ---------- MCP JSON-RPC ----------

interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Answers one MCP JSON-RPC message for a surface. Undefined for notifications (no id). A tool that
 * throws comes back as an MCP tool error (`isError`), so the AI reads the reason and can try again.
 */
export async function handleToolMcp(message: JsonRpcMessage, surface: ToolSurface, serverName: string, call: ToolCall): Promise<object | undefined> {
  if (!message || message.id === undefined || message.id === null) return undefined;
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: serverName, version: "1.0.0" } } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolsFor(surface).map(listedTool) } };
    case "tools/call": {
      const name = message.params?.name ?? "";
      if (!findTool(surface, name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const raw = message.params?.arguments;
      const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      try {
        const value = await call(name, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] } };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }
}

// ---------- running an app route in-process ----------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Runs one request through the Express app without a socket and returns its status and JSON body. */
export function injectRequest(app: Handler, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 10 * 60_000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    const req = new IncomingMessage(socket as never);
    req.method = method; req.url = path; req.httpVersion = "1.1"; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const json = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host: "127.0.0.1", ...headers, ...(json ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) } : {}) };
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const collect = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function") return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding as BufferEncoding : "utf8"));
    };
    let finished = false;
    const timer = setTimeout(() => { if (!finished) { finished = true; reject(new Error(`응답이 없습니다: ${method} ${path}`)); } }, timeoutMs);
    timer.unref();
    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      collect(chunk, encoding);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown) => {
      collect(chunk, encoding);
      if (finished) return res;
      finished = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      resolve({ status: res.statusCode, body: parsed });
      res.emit("finish");
      return res;
    }) as typeof res.end;
    try { app(req, res); } catch (error) { clearTimeout(timer); finished = true; reject(error); return; }
    if (json) req.push(json);
    req.complete = true;
    req.push(null);
  });
}

/** `dispatch` for a ToolContext: the route's error message becomes the tool error the AI reads. */
export function routeDispatcher(app: Handler) {
  return async (method: string, path: string, body?: unknown) => {
    const { status, body: output } = await injectRequest(app, method, path, body);
    if (status >= 400) {
      const message = output && typeof output === "object" && "error" in output ? String((output as { error: unknown }).error) : `요청 실패 (${status})`;
      throw new Error(message);
    }
    return output;
  };
}
