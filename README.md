# Sinawi

[한국어](README.ko.md)

Sinawi is a macOS app that runs the coding-agent CLIs you already have — **Codex**, **Claude Code** and **Grok Build** — as one team. One agent leads: it plans, splits the work and hands pieces to the others as workers. You watch every step live and can step in at any time.

The name comes from *sinawi* (시나위), a form of improvised ensemble music in Korean traditional music.

## Why

Each CLI is good at different things. Having one agent delegate to the others tends to give better results than any single agent alone, but doing that by hand means juggling terminals and copying output between them. Sinawi does the coordination: it routes the request, writes the briefs, runs the workers, checks their reports and keeps the whole run visible.

## What it does

- **Lead and workers.** Pick a lead and any mix of workers, or let *Auto* routing choose a team, models and skills for the request. The lead delegates with structured briefs (goal, context, done criteria, constraints, verification, report format); Sinawi fills in missing parts and sends results back to the lead.
- **Permission modes**, like Claude Code: *Plan* (read-only, the lead proposes a plan you can run with one click), *Auto* (edits in the project folder, never stops to ask), and *Full access* (only when the workspace allows it).
- **Live view.** Messages, tool calls, commands and file changes stream in as they happen, with a clear indicator of what the team is doing right now — including when it is waiting on a CI run or deploy.
- **Workspaces.** Keep conversations, projects and defaults apart (switch with F1 / F2). Each workspace has its own policy: which agents may run, whether computer control or full access is allowed, and which MCP tools are blocked.
- **Quota fallback.** When one CLI is about to run out of quota, Sinawi can switch that role to the next agent you configured.
- **Built-in browser and computer use.** Agents can drive the app's own browser tab (snapshot, click, type, screenshot) and, with your macOS permission, other native apps.
- **Worktrees, terminal and files.** Work in git worktrees, open a terminal per session, and preview images, PDFs and Markdown the agents produce.
- **Slash menu.** `/clear`, `/compact`, `/usage` and every installed skill, searchable by name.
- **Skills.** Reads skills from `~/.claude/skills`, `~/.codex/skills`, `~/.codex/prompts`, `~/.grok/skills` and the project's `./skills`, and can attach them to a request automatically.
- **Bots.** Save presets (agent, model, skills, instructions) and let two bots talk for a set number of turns.
- **Usage and updates.** Per-agent usage tracking, and signed auto-updates from GitHub Releases.

Everything runs on your Mac. Sinawi never asks for or stores API keys; it uses each CLI's own login. Your prompts, selected skills and files the agents read are sent to that CLI's model provider, as they would be if you ran the CLI yourself.

## Requirements

- macOS
- [Node.js](https://nodejs.org) **22.12 or newer**, on your login shell's `PATH`
- At least one of these CLIs, installed and logged in:
  - [Codex CLI](https://github.com/openai/codex)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup)
  - [Grok Build](https://docs.x.ai/build/overview)

Sinawi finds the CLIs on your login shell's `PATH` and in common install locations. The help panel in the app shows which ones it found and how to log in.

## Install

There is no prebuilt release yet, so build the app from source. You need [Rust](https://rustup.rs) and the Xcode Command Line Tools (`xcode-select --install`).

```sh
git clone https://github.com/Rakmlabs/sinawi.git
cd sinawi
npm install
npm run app:build
```

The app is written to `src-tauri/target/release/bundle/macos/Sinawi.app`. Copy it to `/Applications` and open it from Finder or the Dock.

The first time an agent uses computer control, macOS asks you to allow Sinawi under **Privacy & Security → Accessibility** and **Screen Recording**. Open Sinawi from Finder or the Dock (not from a terminal) so macOS grants the permission to Sinawi itself.

Data lives in `~/Library/Application Support/dev.sinawi.app/` and logs in `~/Library/Logs/Sinawi/`.

## Development

```sh
npm install
npm run dev        # API on 127.0.0.1:3001, web UI on http://127.0.0.1:5188
npm run app:dev    # the same inside the Tauri window
```

```sh
npm run typecheck
npm test
npm run build      # typecheck, Vite build and the bundled server
```

Both servers bind to `127.0.0.1` only. `SINAWI_PORT` and `SINAWI_DATA_DIR` change the API port and data folder, which is handy for running a second copy alongside the installed app.

### Layout

| Path | What it holds |
|---|---|
| `server/` | Express + WebSocket server: CLI runners, orchestration, routing, supervision, storage |
| `src/` | React UI |
| `src-tauri/` | Tauri v2 shell: window, updater, in-app browser bridge, computer-use bridge |
| `scripts/` | Dev runner, server bundler, signing and release scripts |
| `docs/orchestration/` | Operating rules the app enforces on leads and workers, and the research behind them |
| `docs/RELEASING.md` | How releases and signed auto-updates work |

## Safety

The agents edit files and run commands in the folder you choose. *Plan* mode is read-only, *Auto* mode keeps writes inside the project folder, and *Full access* turns off the CLIs' own sandboxes (for example Claude Code's `--dangerously-skip-permissions`), so it is off unless a workspace explicitly allows it. Sinawi is not a sandbox itself: what an agent can touch ultimately depends on macOS and on each CLI.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`, and keep each change focused on one thing.

## License

[MIT](LICENSE)
