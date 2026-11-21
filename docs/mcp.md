# Project leads and MCP

[한국어](mcp.ko.md) · Full tool list: [mcp-coverage.md](mcp-coverage.md) (Korean)

## Project leads

A project lead is a long-lived chat that owns one project. Create one with **+** next to **Leads** at the top of the sidebar, then keep giving it work in plain language in that chat. The lead keeps notes on what it has learned and can search its earlier conversations; when a conversation grows long it moves to a fresh session and carries on from the notes. Notes, instructions, skills, team, merge policy and schedules are edited in the lead's settings.

Leads belong to a workspace. Their names are unique within that workspace, so different workspaces may use the same name. Name-based API and MCP lookups prefer the caller's workspace. If the name exists in several other workspaces, use the lead ID. A lead can ask another lead only when both are in the same workspace.

### Merge policy

| Policy | What happens to finished worker branches |
|---|---|
| `auto` | Merged into the main folder at the end of the turn. |
| `ask` (default) | Wait on a branch until you approve the merge in the lead panel. |
| `never` | Stay on the work branch. |

### Lead tools (`sinawi_lead`)

A Claude or Codex lead gets an MCP server, `sinawi_lead`, in its own runs (not in *Plan* mode). The lead chooses when to call the tools; there are no keyword rules.

- **Parallel delegation.** `delegate_task` hands a brief to a worker and returns a `task_id` at once; call it several times and the workers run at the same time (two tasks for the same CLI get two workers). `check_task` shows status, `collect_results` waits for and returns the results.
- **Design work.** `delegate_task` with `kind: "design"` makes the worker open the screen in the browser and attach screenshots to its report.
- **Skills.** `write_skill`, `update_skill` and `list_skills` save reusable instructions, for this lead only or for the whole project (`.claude/skills`), and attach them to later briefs.
- **Schedules.** `schedule_create`, `schedule_list`, `schedule_update` (and `schedule_delete`, which needs your approval) let the lead set up deadlines, checks and recurring work it agreed on in the chat.
- **App tools.** The lead also gets the app-wide tools below.
- **Asking another lead.** A lead can ask only another lead in the same workspace. Move one of the leads first when work needs to cross workspace boundaries.

### Schedules

A schedule sends a prompt to the lead's chat at a time: once (`at`) or repeating (5-field cron, e.g. `0 9 * * 1-5`). Times are read in the schedule's IANA time zone, by default this Mac's (for example `Asia/Seoul`). A run missed while the app was off still runs if it is only slightly late; older ones are skipped. You can also add, edit, pause and delete schedules yourself in the lead's settings. Every created, changed or fired schedule shows up as a card in the chat with its next run time.

### Grok leads

Grok Build has no per-run MCP option, so a Grok lead uses the text tag protocol instead (`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`). It cannot call the `sinawi_lead` tools: no parallel `delegate_task`, skills, schedules or app tools. Use Claude or Codex as the lead for those.

## App-wide MCP for other AIs

Sinawi also serves its features as an MCP server, so another AI can be the orchestrator: Claude Code, Codex, Grok Build, Claude Desktop, Cursor or any MCP client can open chats under a lead, send work to a specific chat, pick the agent and model, wait for the result and read it. Every chat it opens shows up live in the app with the client's name, and you can keep talking in it. The same server also covers leads, schedules, workspaces, groups, bots, notifications, skills and settings.

### Connect

Sinawi must be running. Open **Settings → Connect an AI**, pick your client and copy what it shows; the paths and port are already filled in for your Mac. With the app in `/Applications` they look like this:

| Client | How |
|---|---|
| Claude Code | `claude mcp add sinawi --scope user -e SINAWI_URL=http://127.0.0.1:3001 -e SINAWI_MCP_TOKEN_FILE=<token file> -- <node> <bridge>` |
| Codex | `codex mcp add sinawi --env SINAWI_URL=… --env SINAWI_MCP_TOKEN_FILE=… -- <node> <bridge>`, or the `[mcp_servers.sinawi]` block the page shows, in `~/.codex/config.toml` |
| Grok Build | `grok mcp add sinawi -e SINAWI_URL=… -e SINAWI_MCP_TOKEN_FILE=… -- <node> <bridge>`; check with `grok mcp doctor sinawi` |
| Claude Desktop, Cursor | **Connect to Claude Desktop** / **Connect to Cursor** writes the entry for you (below) |
| Anything else | the `mcpServers` JSON on the **Other MCP** tab |

`<bridge>` is the copy of the bridge in `<data folder>/hooks/sinawi-mcp.mjs`, which stays put when the app is moved or updated (`/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs` works too). `<node>` is the Node the app uses. `<token file>` is `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`. The entry reads the token from its file, so no token is copied into a config and a renewed token keeps working. Then restart the client or open a new session.

**Claude Desktop and Cursor, one click.** The button shows the exact JSON; on **Write config** Sinawi merges it into `~/Library/Application Support/Claude/claude_desktop_config.json` or `~/.cursor/mcp.json` (created when missing; every other key and server stays; the original is copied to `<file>.bak`; a file that is not valid JSON is left alone). Then restart the client:

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "/path/to/node",
      "args": ["/Users/<you>/Library/Application Support/dev.sinawi.app/.data/hooks/sinawi-mcp.mjs"],
      "env": {
        "SINAWI_URL": "http://127.0.0.1:3001",
        "SINAWI_MCP_TOKEN_FILE": "/Users/<you>/Library/Application Support/dev.sinawi.app/.data/app-mcp-token"
      }
    }
  }
}
```

These buttons are not MCP tools, and the write is accepted only from the app's own window with the JSON you confirmed: an AI cannot rewire another AI client.

**After the npm package is published**, `npx -y @rakmlabs/sinawi mcp` can stand in for `<node> <bridge>`. It is not published yet, so today `npx` answers 404; use the commands above.

All of these run one file, `packages/sinawi/lib/mcp.mjs`; from a checkout `npm run sinawi-mcp` runs it too. The [package README](../packages/sinawi/README.md) lists the environment variables. [docs/mcp-clients.md](mcp-clients.md) has a page per client.

### Hand work to a lead

The usual loop for an orchestrator:

1. `list_leads` — the leads (project owners) and their folders.
2. `create_session` with `lead_id`, a `prompt`, and optionally `agent` (`claude`, `codex`, `grok`) and `model` — opens a new chat under that lead and starts it. The lead's folder, instructions and memory are shared by all its chats.
3. `wait_for_session` with the chat id — returns when the turn ends (or after `timeout_sec`) with the status, the lead's last answer and the messages since. If `done` is false it is still running: call again with `after_event_id` set to `lastEventId`.
4. `send_message` to the same chat to continue, or `create_session` again for a parallel chat.
5. `show_session` notifies the user (who asks, with an "open chat" button). The app switches to the chat by itself only when the user has left an empty new-chat screen untouched for 30 seconds; while they look at another chat or settings, or are typing, their screen stays.

In the app the chat appears as a tab under the lead, labelled with the client that opened it; the user can read along and type into it at any time.

### The `@rakmlabs/sinawi` npm package

Not published yet. Once it is, `npx @rakmlabs/sinawi` installs or updates the app (latest GitHub release, checked with `codesign --verify --deep --strict` and `spctl -a -t exec`, asks before replacing `/Applications/Sinawi.app`) and `npx @rakmlabs/sinawi mcp` is the bridge. It is published by hand: bump `packages/sinawi/package.json`, then run **Actions → Publish sinawi (npm) → Run workflow** (`.github/workflows/publish-sinawi.yml`: `npm publish --provenance --access public` with the `NPM_TOKEN` secret). `npm run pkg:pack` shows what would be packed; `npm run pkg:publish` publishes from a logged-in machine without provenance.

### Token

The token is stored in `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token` (mode 0600). The server looks for it in `SINAWI_MCP_TOKEN`, then `SINAWI_MCP_TOKEN_FILE`, then `$SINAWI_DATA_DIR/app-mcp-token`, then that default path, and rereads it on every call. **Make a new token** on **Settings → Connect an AI** rejects the old token immediately.

### Approvals

- **Run at once:** reading, creating (chats, leads, workspaces, groups, bots, schedules, notifications), sending messages, renaming.
- **Need your approval:** deleting, changing settings and policies, merge approve/reject, stopping a run, compacting, removing workers, terminal commands, and moving a chat or group to another workspace (it would take on that workspace's full-access and computer-control policy). Such a call returns `pending_approval`; an approval card appears in the app and nothing runs until you press **Approve**. The AI reads the outcome with `list_approvals`.
- Creating tools refuse risky values: AI-created chats run in *Plan* or *Auto*, never *Full access*, and a new lead cannot start with `auto` merging.

### Known limits

Approvals guard the **MCP tool surface** only. Sinawi's local HTTP API is open to non-browser clients on this Mac, so an agent that has a shell can call it directly and skip the approval card. Give full shell access only to agents you trust.
