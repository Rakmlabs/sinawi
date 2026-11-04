# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Grok, …) working **on this repository**. To *use* Sinawi from an AI, read [docs/ai/for-ai.md](docs/ai/for-ai.md) instead. Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Sinawi: a macOS app that runs the Claude Code, Codex and Grok Build CLIs as one team. Tauri v2 shell + React 19 UI (Vite) + a Node/Express + WebSocket server. TypeScript, ES modules. Node `^22.23.4 || ^24.22.1 || >=26.12.1`.

## Layout

| Path | What it holds |
|---|---|
| `server/` | Express + WebSocket server: CLI runners (`cli.ts`), orchestration (`orchestra.ts`), routing, leads (`steward*.ts`), storage. Entry `server/index.ts`, routes in `server/server.ts`. |
| `server/app-tools.ts` | The MCP tool registry (`APP_TOOLS`, `ROUTE_EXCLUSIONS`) for the lead (`sinawi_lead`) and external (`sinawi`) surfaces. |
| `src/` | React UI. UI text lives in `src/i18n.ts`, Korean and English — add both. |
| `src-tauri/` | Tauri v2 shell (Rust): window, updater, in-app browser bridge, computer-use bridge. |
| `scripts/` | `dev.mjs`, `build-server.mjs` (bundles the server into `src-tauri/resources/server.cjs`), `sinawi-mcp.mjs` (runs the MCP bridge for `npm run sinawi-mcp`), `gen-ai-docs.mjs`, signing and release scripts. |
| `packages/sinawi/` | The npm package `sinawi` (zero dependencies): `npx sinawi` installs the app from the latest release (`lib/install.mjs`), `npx sinawi mcp` is the stdio MCP bridge. `lib/mcp.mjs` is the one bridge implementation: `scripts/sinawi-mcp.mjs` imports it, `build-server.mjs` bundles it into the app (`Contents/Resources/sinawi-mcp.mjs`) and into `server.cjs`, which writes `<data>/hooks/sinawi-mcp.mjs`. Keep it self-contained (node: imports only). Published by hand with the `Publish sinawi (npm)` workflow; tests in `server/sinawi-package.test.ts`. |
| `server/mcp-clients.ts` | Settings → "Connect to Claude Desktop / Cursor": merges `mcpServers.sinawi` into the client's config (`.bak` first). Tests point it at temp files with `SINAWI_CLAUDE_DESKTOP_CONFIG` / `SINAWI_CURSOR_MCP_CONFIG`; never touch the real configs. |
| `docs/` | `mcp.md`, `mcp-coverage.md`, `RELEASING.md`, `orchestration/` (rules the app enforces on leads and workers), `ai/` (docs for AI agents). |
| `*.test.ts` | Tests sit next to the code: `server/*.test.ts`, `src/*.test.ts`, `src/updates/*.test.ts`. |

## Commands

```sh
npm install
npm run dev          # server (tsx server/index.ts) + Vite UI
npm run typecheck    # tsc --noEmit
npm test             # node --import tsx --test server/*.test.ts src/*.test.ts src/updates/*.test.ts
npm run build        # typecheck + vite build + bundled server
npm run docs:ai      # regenerate the tool tables in docs/ai/for-ai*.md
```

- One test file: `node --import tsx --test server/app-tools.test.ts`.
- Tests use a fake CLI runner and temporary data folders: no CLI, no network, no real app data.
- Before you finish: `npm run typecheck`, `npm test` and `npm run build` must exit 0.
- Changed `server/app-tools.ts` (a tool, its description, risk, surface or section)? Run `npm run docs:ai`; `server/ai-docs.test.ts` fails while the docs are stale. A new tool also needs an English line in `EN_SUMMARIES` (`server/ai-docs.ts`); a new route needs a tool or a reasoned `ROUTE_EXCLUSIONS` entry (`server/app-tools.test.ts`).

## Isolated development

The installed app owns `127.0.0.1:3001` and `~/Library/Application Support/dev.sinawi.app/.data`. Never point a dev copy at either.

```sh
SINAWI_PORT=3011 SINAWI_UI_PORT=5198 SINAWI_DATA_DIR="$(mktemp -d)" npm run dev
```

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `SINAWI_PORT` | server (`server/index.ts`, `origin-policy.ts`), Vite proxy, the MCP bridge | `3001` | API and WebSocket port. |
| `SINAWI_UI_PORT` | `vite.config.ts` | `5188` | Vite port (`strictPort`). **Use 5188 or 5198 only**: the server accepts browser origins only from `tauri://localhost`, the API port, 5188 and 5198 (`server/origin-policy.ts`); any other UI port gets 403. |
| `SINAWI_DATA_DIR` | server (`server/runtime.ts`), the MCP bridge | `./.data` (gitignored) | Sessions, leads, tokens, approvals. |

Even an isolated dev server is not fully sandboxed: on start, `server/index.ts` installs the `ao-browser`/`ao-computer`/`ao-serve`/`ao-sim` CLIs into `~/.local/bin` and the `orchestra-browser`/`orchestra-computer` skills into `~/.claude/skills`, `~/.codex/skills` and `~/.grok/skills` (for installed CLIs), and sessions run the real CLIs with their own logins. When you must not touch the home folder, stick to `npm test`, `npm run typecheck` and `npm run build`.

Old `AGENT_ORCHESTRA_<name>` variables still work as fallbacks (`envVar` in `server/runtime.ts`). `npm run app:dev` opens the Tauri window, which is hardwired to port 3001 — do not run it while the installed app is running.

## Releases

Maintainer only, from `main`: see [docs/RELEASING.md](docs/RELEASING.md). In short, `node scripts/release.mjs patch|minor|major --tag --notes notes.md` bumps the version and makes the commit and tag; pushing the `vX.Y.Z` tag lets CI build, sign, notarize and publish. Do not release, tag or bump the version unless asked.

## Commits and pull requests

- Subject line states what is now true, in plain English, no prefix: "Workers run in parallel and get skills the lead picks", "Tests no longer depend on the time of day, worker order or port races". Release commits are `Release vX.Y.Z`.
- One change per commit/PR; refactors separately. Contributors branch from `main` (`fix/…`, `feat/…`) and open a PR that links the issue; the maintainer squash-merges.

## Do not

- Commit, push, tag or publish unless the user asks.
- Use port 3001 or the real app data (`~/Library/Application Support/dev.sinawi.app/`), or touch `~/.claude`, `~/.codex`, `~/.grok` in tests or dev runs; use a temp `SINAWI_DATA_DIR`.
- Commit secrets, signing keys (`*.key`), `.env*`, `.data/`, agent transcripts (`codex-*.jsonl`, `grok-*.out`), screenshots or `release-assets/`.
- Hand-edit the generated block between `<!-- tools:start -->` and `<!-- tools:end -->` in `docs/ai/`.
- Let MCP tools grant themselves more power: full access, approving approvals, answering permission questions and token rotation stay user-only (see `ROUTE_EXCLUSIONS`). Anything hard to undo gets `risk: "approval"`.
- Add UI text in one language only.
