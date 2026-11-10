# Sinawi for AI agents

[한국어](for-ai.ko.md) · Human docs: [README](../../README.md), [docs/mcp.md](../mcp.md), [docs/mcp-coverage.md](../mcp-coverage.md) (Korean, with routes)

A compact, structured reference for an AI that drives Sinawi through MCP or reads its code. Every fact here is taken from the source; the tool tables are generated from `server/app-tools.ts`.

## What Sinawi is

- A macOS app (Tauri v2 shell + React UI + a local Node/Express server) that runs the coding-agent CLIs already installed on the Mac — **Claude Code** (`claude`), **Codex** (`codex`) and **Grok Build** (`grok`) — as one team.
- It never stores API keys; each CLI uses its own login.
- The server listens on `127.0.0.1` only. The installed app always uses port **3001**; data lives in `~/Library/Application Support/dev.sinawi.app/.data`.

## Concepts

| Concept | In the code | What it means |
|---|---|---|
| Chat (session) | `Session` (`server/types.ts`), `/api/sessions` | One conversation with a team. Status `running`/`done`/`error`/`stopped`. Has a working folder (`cwd`), a main agent and workers. |
| Lead (담당, project lead) | `Steward` (`server/types.ts`), `/api/stewards` | A long-lived chat that owns one project (`cwds`) and belongs to one workspace (`workspaceId`, with all its chats). Keeps notes, can search its earlier conversations, moves to a fresh session when long and continues from its notes. Can send a daily report at `report` (`HH:MM`). Leads of the same workspace can ask each other for work (`accept_work`). |
| Workers | `workers: AgentSelection[]` | CLIs the lead delegates briefs to. Parallel delegations run at the same time (two tasks for the same CLI get two workers); one worker's briefs run in order. Workers can run in their own git worktrees. |
| Workspace (공간) | `WorkspaceState`, `/api/workspaces` | Separates chats, groups, leads and defaults (F1/F2 switch). Defaults: folder, team, allowed agents, quota fallback. Policy (`WorkspacePolicy`): `mediaGeneration`, `computerUse`, `fullAccess`, `grokMcp`, `blockedTools`, `authAlertTools`, and `accounts` (`{claude, codex, grok}`: absolute CLI account folders, passed to every run in the workspace as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`; unset is the default login). |
| Project group | `/api/groups` | A sidebar folder of chats inside a workspace. |
| Schedule (일정) | `/api/stewards/:id/schedules`, `/api/schedules/:id` | Sends a prompt to a lead's chat once (`at`) or repeatedly (5-field `cron`, e.g. `0 9 * * 1-5`) in an IANA time zone (default: the Mac's). |
| Skill | `/api/skills`, lead `write_skill` | Markdown instructions. Read from `~/.claude/skills`, `~/.codex/skills`, `~/.codex/prompts`, `~/.grok/skills` and the project's `./skills`; a lead's own skills are for that lead or, with `scope: "project"`, saved in the project's `.claude/skills`. |
| Bot | `/api/bots` | A preset (name, agent, model, skills, instructions). Two bots can talk for a set number of turns. |
| Merge policy | `MergePolicy = "auto" \| "ask" \| "never"` | What happens to a lead's finished worker branches: `auto` merges at the end of the turn, `ask` (default) waits for the user's approval (`pendingMerge`), `never` leaves them on the branch. `create_lead` accepts only `ask`/`never`; `auto` needs `update_lead` (approval). |
| Permission mode | `plan` / `auto` / full access | *Plan* is read-only, *Auto* edits inside the project folder, *Full access* turns off the CLIs' sandboxes and only works when the workspace policy allows it. MCP tools accept only `plan` or `auto`. |
| Approval | `server/app-approvals.ts`, `/api/app-approvals` | A tool with risk `approval` does not run when called. It returns `{"status":"pending_approval","approvalId":"…"}`, the app shows an approval card, and the tool runs only after the user presses **Approve**. Read the outcome with `list_approvals` (`pending`/`approved`/`rejected`/`failed`). |

## MCP surfaces

Both surfaces read the same registry (`APP_TOOLS` in `server/app-tools.ts`). App tools call the app's own HTTP route handlers in-process, so validation and persistence are the UI's.

| Surface | Server name | Endpoint | Auth | Who |
|---|---|---|---|---|
| Lead | `sinawi_lead` | `POST /api/lead-mcp` | That run's token in `x-sinawi-token`; only the lead's own run | A Claude or Codex lead's CLI run (not in *Plan* mode, never Grok). Lead-only tools + app tools. |
| External | `sinawi` | `POST /api/app-mcp` | `Authorization: Bearer <token>` (or `x-sinawi-mcp-token`) | Claude Desktop, Cursor or any MCP client through the stdio bridge (`sinawi mcp`, `packages/sinawi`). App tools only. |

### Connect an MCP client

Sinawi must be running. In order of preference:

1. **In-app button** (Claude Desktop, Cursor): **Settings → General → External AI connection (MCP) → Connect to Claude Desktop / Connect to Cursor**. After the user confirms the exact JSON, the app merges `mcpServers.sinawi` into `~/Library/Application Support/Claude/claude_desktop_config.json` or `~/.cursor/mcp.json`, keeping other entries and a `.bak` copy. The entry is `"command": "<node>", "args": ["<data>/hooks/sinawi-mcp.mjs"], "env": {"SINAWI_URL": …, "SINAWI_MCP_TOKEN_FILE": "<data>/app-mcp-token"}` (no token copied). Routes: `GET`/`POST /api/app-mcp/clients/:client` (`claude`, `cursor`); not MCP tools, and `POST` needs the app's own Origin and the confirmed JSON. Tests move the paths with `SINAWI_CLAUDE_DESKTOP_CONFIG` and `SINAWI_CURSOR_MCP_CONFIG`.
2. **npx**, with the npm package `@rakmlabs/sinawi`: **Copy config** on the same screen gives

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "npx",
      "args": ["-y", "@rakmlabs/sinawi", "mcp"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<token from the settings screen>" }
    }
  }
}
```

3. **The bridge bundled in the app**: `"command": "node"`, `"args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]`, same `env`. The settings screen's "without npx" config points at the copy in `<data>/hooks/sinawi-mcp.mjs` instead (it survives app updates and moves).

From a checkout, `npm run sinawi-mcp` (= `node scripts/sinawi-mcp.mjs`) starts the same stdio bridge. Every form runs one implementation, `packages/sinawi/lib/mcp.mjs`, which has no dependencies (Node 18+). The same npm package installs the app: `npx @rakmlabs/sinawi` (macOS; downloads the latest release, verifies it with `codesign --verify --deep --strict` and `spctl -a -t exec`, asks before replacing `/Applications/Sinawi.app`).

### Bridge environment variables (`sinawi mcp`)

| Variable | Meaning |
|---|---|
| `SINAWI_URL` | App address. Default `http://127.0.0.1:${SINAWI_PORT:-3001}`. |
| `SINAWI_PORT` | Port used when `SINAWI_URL` is not set. |
| `SINAWI_MCP_TOKEN` | The token itself. |
| `SINAWI_MCP_TOKEN_FILE` | A file to read the token from. |
| `SINAWI_DATA_DIR` | Data folder; the token is read from `$SINAWI_DATA_DIR/app-mcp-token`. |

### Token

- Stored in `<data>/app-mcp-token` with mode 0600, created on first use (`server/app-mcp.ts`). Default path: `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`.
- Lookup order in the bridge: `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → the default path. It is reread on every call, so a renewed token works without restarting the client.
- **Make a new token** on the same settings screen (`POST /api/app-mcp/token`) rejects the old token at once. No MCP tool can read or rotate the token.
- A wrong or missing token gets HTTP 401 from `/api/app-mcp`.

## Tools

Surface: `lead` = `sinawi_lead`, `external` = `sinawi`. Approval **yes** = the call returns `pending_approval` and runs only after the user approves it in the app. `tools/list` marks these with `annotations.destructiveHint: true` and a "[승인 필요]" suffix; read-only tools have `readOnlyHint: true`.

<!-- tools:start -->
<!-- Generated from server/app-tools.ts by `npm run docs:ai`. Do not edit by hand. -->

89 tools (85 on the lead surface, 79 on the external surface), 30 of them need approval.

### Lead-only (inside a lead's run)

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `delegate_task` | lead only | no | Hand a brief to a worker (Claude/Codex/Grok CLI) and get a task_id back at once; several calls run in parallel. `kind: "design"` returns screenshots. |
| `check_task` | lead only | no (read) | Status of delegated tasks (running/done/error/stopped); all of this turn's tasks when task_id is empty. |
| `collect_results` | lead only | no (read) | Receive results of delegated tasks, optionally waiting (wait, timeout_sec). Results are returned only once. |
| `write_skill` | lead only | no | Save a reusable skill (instructions in Markdown) for this lead or the project, to attach to later briefs. |
| `update_skill` | lead only | no | Edit the description or body of a skill made with write_skill. |
| `list_skills` | lead only | no (read) | Skills this lead can attach to worker briefs (lead skills and project skills). |
| `schedule_create` | lead only | no | Create a schedule for this lead: at the given time the prompt arrives in the lead's chat. |
| `schedule_list` | lead only | no (read) | This lead's schedules (ID, time, repeat, enabled) plus the current time and time zone. |
| `schedule_update` | lead only | no | Edit, enable or disable one of this lead's schedules. |
| `schedule_delete` | lead only | **yes** | Delete one of this lead's schedules. |

### App status

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `app_overview` | lead, external | no (read) | Overview: installed agent CLIs and availability, enabled skills, bots, project groups, default folder. |
| `app_status` | lead, external | no (read) | Server status: version, running chats, open app windows. |
| `get_setup_status` | lead, external | no (read) | Machine readiness: Node/Git/agent CLIs installed, macOS permissions. |
| `list_workspaces` | lead, external | no (read) | Workspaces, the current one, per-workspace defaults (folder, team, allowed agents), policy and running chats. |

### Chats (sessions)

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_sessions` | lead, external | no (read) | Chats: ID, title, status, agent, folder, whether it is a lead chat. |
| `get_session` | lead, external | no (read) | One chat with its recent messages and events (answers, tool runs, errors). |
| `get_session_summary` | lead, external | no (read) | A chat at a glance: status, the lead's last answer, checklist progress, pending merge, lead info. |
| `create_session` | lead, external | no | Open a new chat; with a prompt it starts working, without one it stays empty. Can open a new thread of a lead (lead_id). |
| `send_message` | lead, external | no | Send a follow-up message to a chat (starts the next turn). |
| `ask_running_session` | lead, external | no | Ask a running chat in the caller's workspace a side question without stopping it. Cross-workspace asking is unavailable. The answer is attached separately. |
| `rename_session` | lead, external | no | Rename a chat (the name shown in the sidebar). |
| `move_session_to_group` | lead, external | no | Put a chat into a project group, or take it out (empty group_id). |
| `move_session_to_workspace` | lead, external | **yes** | Move a chat to another workspace; it then follows that workspace's policy. |
| `stop_session` | lead, external | **yes** | Stop a running chat. |
| `compact_session` | lead, external | **yes** | Compress a long chat's context into a summary (cannot be undone). |
| `delete_session` | lead, external | **yes** | Delete a chat (not while running); optionally clean up worker worktrees. |
| `set_session_team` | lead, external | **yes** | Change a chat's team (main agent, model, workers); not while running. |
| `set_session_auto_switch` | lead, external | **yes** | Turn a chat's auto switch (pick the fitting agent per message) on or off. |
| `remove_session_worker` | lead, external | **yes** | Remove one worker from a chat's team (its conversation history goes too). |
| `list_worktrees` | lead, external | no (read) | A chat's per-worker git worktrees and their state (branch, commits, uncommitted changes). |
| `delete_worktree` | lead, external | **yes** | Delete a worker's git worktree; `force` also discards uncommitted changes. |

### Merges

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `approve_merge` | lead, external | **yes** | Approve a worker-branch merge waiting in a lead chat and merge it into the project. |
| `reject_merge` | lead, external | **yes** | Reject a waiting merge (the branch is not merged). |

### Project leads

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_leads` | lead, external | no (read) | Project leads of one workspace (default: the current one, or the calling lead's): name, team, merge policy (auto/ask/never), folders, daily report time. Names are unique within a workspace. |
| `get_lead` | lead, external | no (read) | One lead's settings, notes and threads (chats). |
| `create_lead` | lead, external | no | Create a project lead for folders (cwds) in a workspace (default: the current one). Its name must be unique in that workspace. Merge policy can only be ask (default) or never. |
| `update_lead` | lead, external | **yes** | Change a lead's settings (name, instructions, team, merge policy, folders, notes, report time) or move it, with its chats, to another workspace. |
| `delete_lead` | lead, external | **yes** | Delete a lead; its chats remain as ordinary chats. |
| `get_session_lead` | lead, external | no (read) | Lead state of a lead chat: lead, notes, pending merge, turn count, report time, and other leads in the same workspace. Leads can ask only leads in that workspace. |
| `update_session_lead` | lead, external | **yes** | Turn a chat's lead mode on or off, or change its name, report time or accept_work. |
| `get_lead_settings` | lead, external | no (read) | App-wide lead settings: default merge policy for migrated leads. |
| `set_legacy_merge_policy` | lead, external | **yes** | Set the default merge policy (auto/ask) for migrated (legacy) leads. |
| `set_all_merge_policies` | lead, external | **yes** | Change every lead's merge policy at once. |

### Schedules

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_lead_schedules` | external only | no (read) | A lead's schedules (each sends a message to the lead's chat at its time). |
| `create_lead_schedule` | external only | no | Create a schedule for a lead: `at` (once) or `cron` (repeating). |
| `update_lead_schedule` | external only | no | Edit, enable or disable a lead's schedule; only given fields change. |
| `delete_lead_schedule` | external only | **yes** | Delete a lead's schedule (to pause it, use update_lead_schedule with enabled:false). |

### User preferences

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `get_user_preferences` | lead, external | no (read) | The user preferences every lead reads (user-preferences.md). |
| `set_user_preferences` | lead, external | **yes** | Replace the whole user preferences text. |

### Workspaces

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `create_workspace` | lead, external | no | Create a workspace; it inherits the current workspace's defaults and policy. |
| `rename_workspace` | lead, external | no | Rename a workspace. |
| `switch_workspace` | lead, external | **yes** | Change the workspace the app is showing. |
| `update_workspace_settings` | lead, external | **yes** | Change a workspace's defaults (replaced whole) or policy (merged): media, computer control, full access, blocked tools, per-agent CLI account folders. |
| `delete_workspace` | lead, external | **yes** | Delete a workspace; its chats and groups move to `move_to` (default: first remaining). Not while chats run. |

### Project groups

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_groups` | lead, external | no (read) | Project groups (sidebar folders of chats): ID, name, workspace. |
| `create_group` | lead, external | no | Create a project group; add chats with move_session_to_group. |
| `rename_group` | lead, external | no | Rename a project group (names are unique within a workspace). |
| `move_group_to_workspace` | lead, external | **yes** | Move a project group and its chats to another workspace. |
| `delete_group` | lead, external | **yes** | Delete a project group (its chats stay, outside any group). |

### Bots

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `create_bot` | lead, external | no | Create a bot (a preset with name, agent and instructions). |
| `delete_bot` | lead, external | **yes** | Delete a bot. |
| `start_bot_conversation` | lead, external | no | Open a chat where two bots talk about a topic for a set number of turns. |

### Notifications

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_notifications` | lead, external | no (read) | App notifications (login needed, limits, permission questions, finished work, lead reports, errors). |
| `notify_user` | lead, external | no | Show the user an app notification. |
| `mark_notifications_read` | lead, external | no | Mark notifications as read (ids or all). |
| `clear_notifications` | lead, external | **yes** | Clear all notifications of a workspace. |

### Skills and tools

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_installed_skills` | lead, external | no (read) | Enabled skills available for a folder: name, description, source. |
| `refresh_skills` | lead, external | no (read) | Reread skills from disk (when a newly installed skill does not show). |
| `list_tools` | lead, external | no (read) | Per-agent MCP servers and skills, enabled state and whether auth is needed (launch details removed). |
| `set_mcp_tool_enabled` | lead, external | **yes** | Enable or disable an agent's MCP server in this workspace (also changes the CLI config). |
| `set_skill_enabled` | lead, external | **yes** | Enable or disable a skill in this workspace. |

### Settings and routing

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `get_settings` | lead, external | no (read) | Routing settings: analysis model, per-agent model lists and login state, routing rules. |
| `refresh_models` | lead, external | no (read) | Recheck the agent CLIs' model lists and login state. |
| `update_routing_settings` | lead, external | **yes** | Save the whole routing settings object (read it with get_settings first). |
| `recommend_team` | lead, external | no (read) | Ask the app's analyzer for a team (main agent, workers, models) for a task. |

### Usage and limits

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `get_usage` | lead, external | no (read) | Token and cost usage of recent runs (by agent, model, chat, role). |
| `get_limits` | lead, external | no (read) | Per-agent usage limits (remaining share, reset time). |
| `refresh_limits` | lead, external | no (read) | Recheck Claude's usage limits now. |

### Files and folders

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `search_files` | lead, external | no (read) | Find files in a folder by name (respects .gitignore). |
| `list_directories` | lead, external | no (read) | Subfolders of a folder (for picking a working folder). |

### Environment

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_permission_requests` | lead, external | no (read) | Permission questions running agents are waiting on (the user answers them in the app). |
| `computer_use_status` | lead, external | no (read) | Computer control state: allowed chats, actions in progress. |
| `stop_computer_use` | lead, external | no | Stop all computer control (mouse/keyboard) at once; a safety stop, so it runs immediately. |
| `list_preview_ports` | lead, external | no (read) | Dev server ports open on this machine (preview targets). |
| `list_simulators` | lead, external | no (read) | iOS simulator devices on this Mac (UDID, name, booted). |
| `list_terminals` | lead, external | no (read) | The app's integrated terminals (ID, folder, running). |
| `run_in_terminal` | lead, external | **yes** | Run a command in an integrated terminal. |
| `close_terminal` | lead, external | **yes** | Close an integrated terminal (its processes end). |

### Approvals

| Tool | Surface | Approval | Summary |
|---|---|---|---|
| `list_approvals` | lead, external | no (read) | Approval requests and their outcome (pending/approved/rejected/failed), by approvalId. |
<!-- tools:end -->

## HTTP API

- Base URL: `http://127.0.0.1:3001` (`SINAWI_PORT` changes the port of a dev server; the installed app is fixed to 3001). All routes are under `/api`; live updates go over the WebSocket `/ws`.
- Access control (`localGuard` in `server/server.ts`, `server/origin-policy.ts`): the `Host` must be loopback (`127.0.0.1`, `localhost`, `::1`). Requests **without** an `Origin` header (CLIs, curl) are allowed; browser requests must come from `tauri://localhost` or `http://127.0.0.1|localhost` on the app port, 5188 or 5198. Otherwise 403.
- There is no other authentication on the plain HTTP API. Only `/api/app-mcp` (bearer token) and `/api/lead-mcp` (run token) check tokens.
- Every route has an MCP tool or an explicit, reasoned exclusion (`ROUTE_EXCLUSIONS`); `server/app-tools.test.ts` enforces it. User-only decisions (approving approvals, answering permission questions, token rotation) have no tool.

## Limits

- **Grok leads use a text tag protocol, not MCP.** Grok Build has no per-run MCP option, so a Grok lead writes tags (`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`) and has no `sinawi_lead` tools: no parallel `delegate_task`, skills, schedules or app tools. Use a Claude or Codex lead for those.
- **Leads in *Plan* mode get no `sinawi_lead` tools** (read-only runs are not given the server).
- **Approvals guard the MCP surface only.** The local HTTP API is open to non-browser clients on the Mac, so an agent with a shell can call it directly (for example with curl) and skip the approval card. Give full shell access only to agents you trust.
- MCP tools refuse risky values even when creating: `permission_mode` is `plan` or `auto` only (full access is the user's switch in the app), `create_session` and `start_bot_conversation` default to `auto`, `create_lead` cannot set `auto` merging, and `list_tools` strips MCP launch details (commands, URLs, env, headers).
- Lead-only tools (`delegate_task`, `collect_results`, …) need a lead's live turn and are not on the external surface. External clients manage schedules with `*_lead_schedule` tools that take a `lead_id`.
- App-window actions (opening Finder, the in-app browser, screenshots) are not MCP tools. Agents drive the in-app browser and computer control through the `orchestra-browser` / `orchestra-computer` skills (`ao-browser`, `ao-computer`) with a run token.
- macOS only.
