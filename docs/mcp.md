# Project leads and MCP

[한국어](mcp.ko.md) · Full tool list: [mcp-coverage.md](mcp-coverage.md) (Korean)

## Project leads

A project lead is a long-lived chat that owns one project. Create one with **+** next to **Leads** at the top of the sidebar, then keep giving it work in plain language in that chat. The lead keeps notes on what it has learned and can search its earlier conversations; when a conversation grows long it moves to a fresh session and carries on from the notes. Notes, instructions, skills, team, merge policy and schedules are edited in the lead's settings.

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

### Schedules

A schedule sends a prompt to the lead's chat at a time: once (`at`) or repeating (5-field cron, e.g. `0 9 * * 1-5`). Times are read in the schedule's IANA time zone, by default this Mac's (for example `Asia/Seoul`). A run missed while the app was off still runs if it is only slightly late; older ones are skipped. You can also add, edit, pause and delete schedules yourself in the lead's settings. Every created, changed or fired schedule shows up as a card in the chat with its next run time.

### Grok leads

Grok Build has no per-run MCP option, so a Grok lead uses the text tag protocol instead (`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`). It cannot call the `sinawi_lead` tools: no parallel `delegate_task`, skills, schedules or app tools. Use Claude or Codex as the lead for those.

## App-wide MCP for other AIs

Sinawi also serves its features as an MCP server for other AI clients such as Claude Desktop: chats, leads, schedules, workspaces, groups, bots, notifications, skills, settings and more.

### Connect Claude Desktop

1. In Sinawi, open **Settings → General → External AI connection (MCP)** and press **Copy config**. The app writes `<data folder>/hooks/sinawi-mcp.mjs` and shows a config with the token filled in.
2. In Claude Desktop, open **Settings → Developer → Edit Config** and add it to `mcpServers` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "/path/to/node",
      "args": ["/Users/<you>/Library/Application Support/dev.sinawi.app/.data/hooks/sinawi-mcp.mjs"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<token from the settings screen>" }
    }
  }
}
```

3. Restart Claude Desktop. Sinawi must be running.

From a checkout, `npm run sinawi-mcp` (or `node scripts/sinawi-mcp.mjs`) starts the same stdio server.

### Token

The token is stored in `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token` (mode 0600). The server looks for it in `SINAWI_MCP_TOKEN`, then `SINAWI_MCP_TOKEN_FILE`, then `$SINAWI_DATA_DIR/app-mcp-token`, then that default path, and rereads it on every call. **Regenerate token** on the same settings screen rejects the old token immediately.

### Approvals

- **Run at once:** reading, creating (chats, leads, workspaces, groups, bots, schedules, notifications), sending messages, renaming.
- **Need your approval:** deleting, changing settings and policies, merge approve/reject, stopping a run, compacting, removing workers, terminal commands, and moving a chat or group to another workspace (it would take on that workspace's full-access and computer-control policy). Such a call returns `pending_approval`; an approval card appears in the app and nothing runs until you press **Approve**. The AI reads the outcome with `list_approvals`.
- Creating tools refuse risky values: AI-created chats run in *Plan* or *Auto*, never *Full access*, and a new lead cannot start with `auto` merging.

### Known limits

Approvals guard the **MCP tool surface** only. Sinawi's local HTTP API is open to non-browser clients on this Mac, so an agent that has a shell can call it directly and skip the approval card. Give full shell access only to agents you trust.
