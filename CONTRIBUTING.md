# Contributing to Sinawi

Thanks for helping. Sinawi is a macOS app (Tauri + React) with a Node server that drives the Claude Code, Codex and Grok CLIs.

## How work flows

1. **Issue first.** Open an issue for a bug or an idea before writing much code, or pick an open one. Issues labelled `help wanted` or `good first issue` are free to take. Say in a comment that you are on it.
2. **Branch from `main`.** Name it after the change, such as `fix/stall-false-positive` or `feat/goal-board`. Never push to `main` directly.
3. **Open a pull request** against `main`, early as a draft if you want feedback. Link the issue (`Fixes #12`) so it closes on merge.
4. **CI must pass.** The check runs the typecheck, `npm test`, the web and server build, `cargo check` and `cargo test`.
5. **Review, then squash-merge.** A maintainer reviews. The PR title becomes the commit on `main`.

## Set up

```sh
git clone https://github.com/Rakmlabs/sinawi.git
cd sinawi
npm install
npm run dev        # server on 127.0.0.1:3001 and the web UI through Vite
npm run app:dev    # the desktop app
```

At least one of the `claude`, `codex` or `grok` CLIs must be installed and logged in to run sessions. If the Sinawi app is already running, stop it first or set `SINAWI_PORT` and `SINAWI_DATA_DIR` for the dev server, so the two do not share a port or data.

## Before you push

```sh
npm run typecheck
npm test
```

- Add or update tests next to the code (`server/*.test.ts`, `src/*.test.ts`). Tests use a fake CLI runner, so they need no CLI and no network.
- Describe in the PR what you checked by hand with a real CLI, and what you did not.
- UI text lives in `src/i18n.ts`, in Korean and English. Add both.

## Commits and pull requests

- Write the title as what is now true: "Workers are no longer stopped for ordinary work", not "fix stuff".
- Keep one change per pull request. Refactors go in their own PR.
- Do not commit secrets, signing keys, `.env` files or session data (`.data/`).

## Releases

Maintainers cut releases from `main`. See [docs/RELEASING.md](docs/RELEASING.md).
