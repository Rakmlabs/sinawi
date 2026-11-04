# Contributing to Sinawi

Thanks for helping. [한국어 안내는 아래에 있습니다](#한국어-안내). Sinawi is a macOS app (Tauri + React) with a Node server that drives the Claude Code, Codex and Grok CLIs.

## How work flows

The maintainer works on `main` and cuts releases from it, so `main` is always the latest state. Everyone else works through issues and pull requests:

1. **Found a problem? Open an issue.** Use the bug report form: what happened, how to reproduce it, and your Sinawi and CLI versions. Ideas go in a feature request. Issues labelled `help wanted` or `good first issue` are free to take. Say in a comment that you are on it.
2. **Branch from the latest `main`.** Name the branch after the change, such as `fix/stall-false-positive` or `feat/goal-board`.
3. **Open a pull request** against `main` and link the issue (`Fixes #12`) so it closes on merge. A draft is fine if you want early feedback.
4. **CI must pass.** It runs the typecheck, `npm test`, the web and server build, `cargo check` and `cargo test`.
5. **The maintainer reviews and squash-merges.** The PR title becomes the commit on `main`, and the fix ships in the next release.

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
- Coding agents: read [AGENTS.md](AGENTS.md) and [docs/ai/for-ai.md](docs/ai/for-ai.md) first.
- Do not commit secrets, signing keys, `.env` files or session data (`.data/`).

## Releases

Maintainers cut releases from `main`. See [docs/RELEASING.md](docs/RELEASING.md).

## Code of conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

---

## 한국어 안내

- **버그나 아이디어:** [이슈](https://github.com/Rakmlabs/sinawi/issues/new/choose)에서 버그 신고나 기능 제안 양식을 쓰세요. 한국어로 써도 됩니다. 질문은 [Discussions](https://github.com/Rakmlabs/sinawi/discussions)에 올려 주세요.
- **작업 순서:** 최신 `main`에서 브랜치를 만들고(`fix/...`, `feat/...`), 이슈를 연결한 풀 리퀘스트(`Fixes #12`)를 보내 주세요. CI(typecheck, test, build, cargo)가 통과해야 하고, 메인테이너가 squash merge합니다.
- **개발 환경:** `npm install` 후 `npm run dev`(서버 127.0.0.1:3001 + Vite UI) 또는 `npm run app:dev`. 설치된 앱이 켜져 있으면 끄거나 `SINAWI_PORT`, `SINAWI_DATA_DIR`를 따로 주세요.
- **푸시 전:** `npm run typecheck`, `npm test`. 테스트는 코드 옆(`server/*.test.ts`, `src/*.test.ts`)에 두고, 가짜 CLI를 쓰므로 CLI나 네트워크가 필요 없습니다. UI 문구는 `src/i18n.ts`에 한국어와 영어 둘 다 넣어 주세요.
- **커밋/PR 제목:** 이제 무엇이 참인지로 씁니다. 한 PR에는 변경 하나만 담고, 비밀값이나 `.data/`는 커밋하지 마세요.
- **릴리즈:** 메인테이너가 `main`에서 냅니다. [docs/RELEASING.md](docs/RELEASING.md) 참고.
- **보안:** 공개 이슈 대신 [SECURITY.md](SECURITY.md) 방법으로 알려 주세요. 모두 [행동 강령](CODE_OF_CONDUCT.md)을 따릅니다.
