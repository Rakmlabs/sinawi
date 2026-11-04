import { readFile } from "node:fs/promises";
import { APP_TOOLS, LEAD_TOOL_NAMES, type AppTool } from "./app-tools.js";

/**
 * The tool tables in docs/ai/for-ai.md and docs/ai/for-ai.ko.md, built from the registry in
 * server/app-tools.ts. `npm run docs:ai` (scripts/gen-ai-docs.mjs) rewrites only the part between
 * the markers; server/ai-docs.test.ts fails when a doc and the registry drift apart.
 *
 * Groups come from the `// ----- name -----` comments in the registry source, so a tool lands in the
 * section it is written in. The Korean doc uses the registry's own (Korean) descriptions; the English
 * doc uses EN_SUMMARIES and falls back to the registry text, so a new tool is never left out.
 */
export const TOOLS_START = "<!-- tools:start -->";
export const TOOLS_END = "<!-- tools:end -->";
export const AI_DOCS = { en: "docs/ai/for-ai.md", ko: "docs/ai/for-ai.ko.md" } as const;
export type DocLang = keyof typeof AI_DOCS;

const LEAD_GROUP = "담당 전용";

/** English names for the registry's section comments; a new section must be added here. */
const GROUP_EN: Record<string, string> = {
  [LEAD_GROUP]: "Lead-only (inside a lead's run)",
  "앱 상태": "App status",
  "채팅(세션)": "Chats (sessions)",
  "병합": "Merges",
  "담당(프로젝트 리드)": "Project leads",
  "일정": "Schedules",
  "사용자 선호": "User preferences",
  "워크스페이스": "Workspaces",
  "프로젝트 그룹": "Project groups",
  "봇": "Bots",
  "알림": "Notifications",
  "스킬·도구": "Skills and tools",
  "설정·배정": "Settings and routing",
  "사용량·한도": "Usage and limits",
  "파일·폴더": "Files and folders",
  "환경": "Environment",
  "승인": "Approvals",
};

/** One-line English summaries. Missing entries fall back to the registry's Korean description. */
export const EN_SUMMARIES: Record<string, string> = {
  delegate_task: "Hand a brief to a worker (Claude/Codex/Grok CLI) and get a task_id back at once; several calls run in parallel. `kind: \"design\"` returns screenshots.",
  check_task: "Status of delegated tasks (running/done/error/stopped); all of this turn's tasks when task_id is empty.",
  collect_results: "Receive results of delegated tasks, optionally waiting (wait, timeout_sec). Results are returned only once.",
  write_skill: "Save a reusable skill (instructions in Markdown) for this lead or the project, to attach to later briefs.",
  update_skill: "Edit the description or body of a skill made with write_skill.",
  list_skills: "Skills this lead can attach to worker briefs (lead skills and project skills).",
  schedule_create: "Create a schedule for this lead: at the given time the prompt arrives in the lead's chat.",
  schedule_list: "This lead's schedules (ID, time, repeat, enabled) plus the current time and time zone.",
  schedule_update: "Edit, enable or disable one of this lead's schedules.",
  schedule_delete: "Delete one of this lead's schedules.",
  app_overview: "Overview: installed agent CLIs and availability, enabled skills, bots, project groups, default folder.",
  app_status: "Server status: version, running chats, open app windows.",
  get_setup_status: "Machine readiness: Node/Git/agent CLIs installed, macOS permissions.",
  list_workspaces: "Workspaces, the current one, per-workspace defaults (folder, team, allowed agents), policy and running chats.",
  list_sessions: "Chats: ID, title, status, agent, folder, whether it is a lead chat.",
  get_session: "One chat with its recent messages and events (answers, tool runs, errors).",
  get_session_summary: "A chat at a glance: status, the lead's last answer, checklist progress, pending merge, lead info.",
  create_session: "Open a new chat; with a prompt it starts working, without one it stays empty. Can open a new thread of a lead (lead_id).",
  send_message: "Send a follow-up message to a chat (starts the next turn).",
  ask_running_session: "Ask a running chat in the caller's workspace a side question without stopping it. Cross-workspace asking is unavailable. The answer is attached separately.",
  rename_session: "Rename a chat (the name shown in the sidebar).",
  move_session_to_group: "Put a chat into a project group, or take it out (empty group_id).",
  move_session_to_workspace: "Move a chat to another workspace; it then follows that workspace's policy.",
  stop_session: "Stop a running chat.",
  compact_session: "Compress a long chat's context into a summary (cannot be undone).",
  delete_session: "Delete a chat (not while running); optionally clean up worker worktrees.",
  set_session_team: "Change a chat's team (main agent, model, workers); not while running.",
  set_session_auto_switch: "Turn a chat's auto switch (pick the fitting agent per message) on or off.",
  remove_session_worker: "Remove one worker from a chat's team (its conversation history goes too).",
  list_worktrees: "A chat's per-worker git worktrees and their state (branch, commits, uncommitted changes).",
  delete_worktree: "Delete a worker's git worktree; `force` also discards uncommitted changes.",
  approve_merge: "Approve a worker-branch merge waiting in a lead chat and merge it into the project.",
  reject_merge: "Reject a waiting merge (the branch is not merged).",
  list_leads: "Project leads of one workspace (default: the current one, or the calling lead's): name, team, merge policy (auto/ask/never), folders, daily report time. Names are unique within a workspace.",
  get_lead: "One lead's settings, notes and threads (chats).",
  create_lead: "Create a project lead for folders (cwds) in a workspace (default: the current one). Its name must be unique in that workspace. Merge policy can only be ask (default) or never.",
  update_lead: "Change a lead's settings (name, instructions, team, merge policy, folders, notes, report time) or move it, with its chats, to another workspace.",
  delete_lead: "Delete a lead; its chats remain as ordinary chats.",
  get_session_lead: "Lead state of a lead chat: lead, notes, pending merge, turn count, report time, and other leads in the same workspace. Leads can ask only leads in that workspace.",
  update_session_lead: "Turn a chat's lead mode on or off, or change its name, report time or accept_work.",
  get_lead_settings: "App-wide lead settings: default merge policy for migrated leads.",
  set_legacy_merge_policy: "Set the default merge policy (auto/ask) for migrated (legacy) leads.",
  set_all_merge_policies: "Change every lead's merge policy at once.",
  list_lead_schedules: "A lead's schedules (each sends a message to the lead's chat at its time).",
  create_lead_schedule: "Create a schedule for a lead: `at` (once) or `cron` (repeating).",
  update_lead_schedule: "Edit, enable or disable a lead's schedule; only given fields change.",
  delete_lead_schedule: "Delete a lead's schedule (to pause it, use update_lead_schedule with enabled:false).",
  get_user_preferences: "The user preferences every lead reads (user-preferences.md).",
  set_user_preferences: "Replace the whole user preferences text.",
  create_workspace: "Create a workspace; it inherits the current workspace's defaults and policy.",
  rename_workspace: "Rename a workspace.",
  switch_workspace: "Change the workspace the app is showing.",
  update_workspace_settings: "Change a workspace's defaults (replaced whole) or policy (merged): media, computer control, full access, blocked tools, per-agent CLI account folders.",
  delete_workspace: "Delete a workspace; its chats and groups move to `move_to` (default: first remaining). Not while chats run.",
  list_groups: "Project groups (sidebar folders of chats): ID, name, workspace.",
  create_group: "Create a project group; add chats with move_session_to_group.",
  rename_group: "Rename a project group (names are unique within a workspace).",
  move_group_to_workspace: "Move a project group and its chats to another workspace.",
  delete_group: "Delete a project group (its chats stay, outside any group).",
  create_bot: "Create a bot (a preset with name, agent and instructions).",
  delete_bot: "Delete a bot.",
  start_bot_conversation: "Open a chat where two bots talk about a topic for a set number of turns.",
  list_notifications: "App notifications (login needed, limits, permission questions, finished work, lead reports, errors).",
  notify_user: "Show the user an app notification.",
  mark_notifications_read: "Mark notifications as read (ids or all).",
  clear_notifications: "Clear all notifications of a workspace.",
  list_installed_skills: "Enabled skills available for a folder: name, description, source.",
  refresh_skills: "Reread skills from disk (when a newly installed skill does not show).",
  list_tools: "Per-agent MCP servers and skills, enabled state and whether auth is needed (launch details removed).",
  set_mcp_tool_enabled: "Enable or disable an agent's MCP server in this workspace (also changes the CLI config).",
  set_skill_enabled: "Enable or disable a skill in this workspace.",
  get_settings: "Routing settings: analysis model, per-agent model lists and login state, routing rules.",
  refresh_models: "Recheck the agent CLIs' model lists and login state.",
  update_routing_settings: "Save the whole routing settings object (read it with get_settings first).",
  recommend_team: "Ask the app's analyzer for a team (main agent, workers, models) for a task.",
  get_usage: "Token and cost usage of recent runs (by agent, model, chat, role).",
  get_limits: "Per-agent usage limits (remaining share, reset time).",
  refresh_limits: "Recheck Claude's usage limits now.",
  search_files: "Find files in a folder by name (respects .gitignore).",
  list_directories: "Subfolders of a folder (for picking a working folder).",
  list_permission_requests: "Permission questions running agents are waiting on (the user answers them in the app).",
  computer_use_status: "Computer control state: allowed chats, actions in progress.",
  stop_computer_use: "Stop all computer control (mouse/keyboard) at once; a safety stop, so it runs immediately.",
  list_preview_ports: "Dev server ports open on this machine (preview targets).",
  list_simulators: "iOS simulator devices on this Mac (UDID, name, booted).",
  list_terminals: "The app's integrated terminals (ID, folder, running).",
  run_in_terminal: "Run a command in an integrated terminal.",
  close_terminal: "Close an integrated terminal (its processes end).",
  list_approvals: "Approval requests and their outcome (pending/approved/rejected/failed), by approvalId.",
};

interface GroupedTool { group: string; tool: AppTool }

/** Assigns each registry tool to the section comment above it in server/app-tools.ts. */
export function groupTools(source: string, tools: AppTool[] = APP_TOOLS): GroupedTool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const groupOf = new Map<string, string>();
  for (const name of LEAD_TOOL_NAMES) groupOf.set(name, LEAD_GROUP);
  let group: string | undefined;
  for (const line of source.split("\n")) {
    const heading = /^\s*\/\/ -{3,} (.+?) -{3,}\s*$/u.exec(line);
    if (heading) { group = heading[1].replace(/\s+\(.*\)$/u, "").trim(); continue; }
    for (const match of line.matchAll(/\bname: "([a-z0-9_]+)"/gu)) {
      const name = match[1];
      if (!byName.has(name) || groupOf.has(name)) continue;
      if (!group) throw new Error(`${name} has no section comment above it in server/app-tools.ts`);
      groupOf.set(name, group);
    }
  }
  return tools.map((tool) => {
    const found = groupOf.get(tool.name);
    if (!found) throw new Error(`could not find the section of ${tool.name}`);
    if (!(found in GROUP_EN)) throw new Error(`add an English name for the section "${found}" to GROUP_EN in server/ai-docs.ts`);
    return { group: found, tool };
  });
}

const cell = (text: string) => text.replace(/\|/gu, "\\|").replace(/\s*\n\s*/gu, " ").trim();

function surfaceLabel(tool: AppTool, lang: DocLang): string {
  const lead = tool.surfaces.includes("lead");
  const external = tool.surfaces.includes("external");
  if (lang === "ko") return lead && external ? "담당·외부" : lead ? "담당만" : "외부만";
  return lead && external ? "lead, external" : lead ? "lead only" : "external only";
}

function riskLabel(tool: AppTool, lang: DocLang): string {
  if (lang === "ko") return tool.risk === "approval" ? "**필요**" : tool.risk === "read" ? "아니오(읽기)" : "아니오";
  return tool.risk === "approval" ? "**yes**" : tool.risk === "read" ? "no (read)" : "no";
}

/** The generated block (without the markers) for one language. */
export function renderToolTables(source: string, lang: DocLang): string {
  const stale = Object.keys(EN_SUMMARIES).filter((name) => !APP_TOOLS.some((tool) => tool.name === name));
  if (stale.length) throw new Error(`EN_SUMMARIES names tools that no longer exist: ${stale.join(", ")}`);
  const grouped = groupTools(source);
  const order = [...new Set(grouped.map((item) => item.group))];
  const approvals = grouped.filter((item) => item.tool.risk === "approval").length;
  const lines: string[] = [];
  lines.push(lang === "ko"
    ? `<!-- \`npm run docs:ai\`가 server/app-tools.ts에서 만든 구간입니다. 손으로 고치지 마세요. -->`
    : `<!-- Generated from server/app-tools.ts by \`npm run docs:ai\`. Do not edit by hand. -->`);
  lines.push("");
  lines.push(lang === "ko"
    ? `도구 ${grouped.length}개 (담당 표면 ${grouped.filter((item) => item.tool.surfaces.includes("lead")).length}개, 외부 표면 ${grouped.filter((item) => item.tool.surfaces.includes("external")).length}개), 그중 승인 필요 ${approvals}개.`
    : `${grouped.length} tools (${grouped.filter((item) => item.tool.surfaces.includes("lead")).length} on the lead surface, ${grouped.filter((item) => item.tool.surfaces.includes("external")).length} on the external surface), ${approvals} of them need approval.`);
  for (const group of order) {
    lines.push("");
    lines.push(`### ${lang === "ko" ? group : GROUP_EN[group]}`);
    lines.push("");
    lines.push(lang === "ko" ? "| 도구 | 표면 | 승인 | 설명 |" : "| Tool | Surface | Approval | Summary |");
    lines.push("|---|---|---|---|");
    for (const { tool } of grouped.filter((item) => item.group === group)) {
      const text = lang === "ko" ? tool.description : EN_SUMMARIES[tool.name] ?? tool.description;
      lines.push(`| \`${tool.name}\` | ${surfaceLabel(tool, lang)} | ${riskLabel(tool, lang)} | ${cell(text)} |`);
    }
  }
  return lines.join("\n");
}

/** Replaces what is between the markers; throws when they are missing or out of order. */
export function replaceBetweenMarkers(doc: string, block: string): string {
  const start = doc.indexOf(TOOLS_START);
  const end = doc.indexOf(TOOLS_END);
  if (start < 0 || end < 0 || end < start) throw new Error(`missing ${TOOLS_START} … ${TOOLS_END} markers`);
  return `${doc.slice(0, start + TOOLS_START.length)}\n${block}\n${doc.slice(end)}`;
}

/** Each AI doc as it should be on disk, from the registry source and the current doc text. */
export async function expectedAiDocs(root: string): Promise<Array<{ lang: DocLang; path: string; current: string; expected: string }>> {
  const source = await readFile(`${root}/server/app-tools.ts`, "utf8");
  return Promise.all((Object.keys(AI_DOCS) as DocLang[]).map(async (lang) => {
    const path = `${root}/${AI_DOCS[lang]}`;
    const current = await readFile(path, "utf8");
    return { lang, path, current, expected: replaceBetweenMarkers(current, renderToolTables(source, lang)) };
  }));
}
