# 오케스트레이터별 시나위 MCP 연결 안내

> 작성 2026-11-21. 앱의 **설정 → 외부 AI 연결** 화면이 아래 명령을 내 Mac의 경로로 채워서 보여 준다. 바깥 AI(오케스트레이터)가 시나위를 "일을 맡길 곳"으로 쓰도록 MCP에 등록하는 방법을 클라이언트별로 모았다.
>
> 표기: **✅ 실제 연결 확인**(임시 시나위 서버에 붙여 핸드셰이크·도구 목록까지 확인) · **📄 공식 문서로 형식 확인** · **⚠️ 추측**(공식 문서로 확인 못 함)

## 0. 시나위 쪽 사실 (코드 확인)

| 항목 | 값 | 근거 |
|---|---|---|
| 서버 주소 | `http://127.0.0.1:3001` (`SINAWI_PORT`로 변경) — 이 Mac 안에서만 | `server/app-mcp.ts` `appUrl()` |
| MCP 엔드포인트 | `POST /api/app-mcp`, JSON-RPC 한 건 요청 → `application/json` 한 건 응답. 알림은 `202`. `GET`/`DELETE`는 `404`(SSE 스트림·세션 ID 없음) | `server/server.ts:1368`, 직접 curl 확인 |
| 인증 | `Authorization: Bearer <토큰>` (또는 `x-sinawi-mcp-token`). 없거나 틀리면 `401` | `presentedToken()` |
| 토큰 위치 | `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token` (0600). 설정 → 외부 AI 연결에서 경로 보기·재발급 | `server/app-mcp.ts` |
| 프로토콜 버전 | `2025-06-18`, `2025-03-26`, `2024-11-05` | `server/app-tools.ts` `MCP_VERSIONS` |
| 도구 수 | 외부 표면 81개(승인 필요 30개 포함, 담당 전용 도구 제외) | `tools/list` 직접 확인 |
| stdio 브리지 | `packages/sinawi/lib/mcp.mjs` 한 파일. 앱 안 사본: `/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs`, 데이터 폴더 사본: `<데이터 폴더>/hooks/sinawi-mcp.mjs` | `src-tauri/tauri.conf.json` resources |
| Node 실행기 | 설정 → 외부 AI 연결이 보여 주는 명령은 Node 절대 경로 대신 `<데이터 폴더>/hooks/sinawi-node`를 쓴다. 앱이 쓰던 Node → PATH의 `node` → `/opt/homebrew/bin/node`·`/usr/local/bin/node`·`/usr/bin/node` 순으로 찾아 실행하므로, n·nvm으로 Node 버전을 바꿔도 등록한 연결이 깨지지 않는다. 아래 예시의 `node`도 PATH에 node가 있으면 그대로 된다 | `server/app-mcp.ts` `launcherSource` |
| 브리지 환경 변수 | `SINAWI_URL` → 없으면 `http://127.0.0.1:${SINAWI_PORT:-3001}`. 토큰: `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → 기본 토큰 파일. **같은 Mac이면 env 없이도 기본 토큰 파일을 읽는다**(호출마다 다시 읽어 재발급에도 안 끊김) | `packages/sinawi/lib/mcp.mjs` |

### 꼭 알아 둘 것

- **npm 패키지 `@rakmlabs/sinawi`는 2026-11-21 현재 npm 레지스트리에 없다(404).** README의 `npx -y @rakmlabs/sinawi mcp` 구성은 게시 전까지 실패한다. 아래 안내는 모두 **앱 번들 브리지**를 1순위로 쓴다. 게시되면 `node <경로>` 대신 `npx -y @rakmlabs/sinawi mcp`로 바꾸면 된다.
- GUI 앱(Claude Desktop, Cursor, VS Code)은 로그인 셸의 `PATH`를 못 볼 수 있다. `"command": "node"`가 안 되면 `which node`의 **절대 경로**를 쓴다.
- 시나위 앱이 켜져 있어야 한다. 꺼져 있으면 브리지가 "Sinawi is not reachable at …" 오류를 돌려준다.
- 토큰을 구성 파일에 직접 붙여 넣는 대신, **stdio 브리지 + env 없음**(기본 토큰 파일 자동)이나 **HTTP + 환경 변수 참조**를 권한다.

### 두 가지 연결 방식

| 방식 | 장점 | 단점 |
|---|---|---|
| **A. stdio 브리지** (권장) | 모든 MCP 클라이언트가 지원. 토큰을 구성에 안 적어도 됨. 공식 지원 경로 | Node 필요 |
| **B. HTTP 직접** (`http://127.0.0.1:3001/api/app-mcp`) | 프로세스를 안 띄움 | 시나위 문서에 공식 지원으로 적혀 있지 않다. 스펙상 GET에 `405`를 주는 게 권장인데 `404`를 준다. Claude Code·Grok Build에서는 실제로 붙었으나 다른 클라이언트는 미확인 |

---

## 1. Claude Code

공식 문서: https://code.claude.com/docs/en/mcp — 범위 `local`(기본, `~/.claude.json`의 이 프로젝트 항목), `project`(프로젝트 루트 `.mcp.json`, 팀원은 승인 프롬프트), `user`(`~/.claude.json`, 모든 프로젝트). 📄

**A. stdio** ✅ (Claude Code 2.1.328, `claude mcp list` → `✔ Connected`)

```sh
claude mcp add sinawi --scope user -- node /Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs
```

`.mcp.json`(프로젝트 공유용)으로 쓰면:

```json
{
  "mcpServers": {
    "sinawi": {
      "type": "stdio",
      "command": "node",
      "args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
    }
  }
}
```

**B. HTTP** ✅ (같은 버전에서 `✔ Connected`. 헤더의 `${VAR}`는 Claude Code가 실행 시 환경 변수로 바꿨다)

```sh
export SINAWI_MCP_TOKEN="$(cat "$HOME/Library/Application Support/dev.sinawi.app/.data/app-mcp-token")"
claude mcp add sinawi --scope user --transport http http://127.0.0.1:3001/api/app-mcp \
  --header 'Authorization: Bearer ${SINAWI_MCP_TOKEN}'
```

확인: `claude mcp list`, 세션 안에서 `/mcp`.

## 2. Codex CLI

공식 문서: https://developers.openai.com/codex/mcp — `~/.codex/config.toml`(또는 신뢰한 프로젝트의 `.codex/config.toml`)의 `[mcp_servers.<이름>]`. stdio는 `command`/`args`/`env`, HTTP는 `url` + `bearer_token_env_var`. 📄 `codex mcp add --help`(codex-cli 0.169.1)로 플래그 확인.

**A. stdio** 📄 (구성 작성·`codex mcp list` 표시까지 확인. 모델 실행이 필요한 실제 핸드셰이크는 미확인)

```sh
codex mcp add sinawi -- node /Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs
```

```toml
# ~/.codex/config.toml
[mcp_servers.sinawi]
command = "node"
args = ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
```

**B. HTTP** 📄 (구성·`codex mcp list`의 `Auth: Bearer token` 표시까지 확인, 핸드셰이크 미확인)

```sh
export SINAWI_MCP_TOKEN="$(cat "$HOME/Library/Application Support/dev.sinawi.app/.data/app-mcp-token")"
codex mcp add sinawi --url http://127.0.0.1:3001/api/app-mcp --bearer-token-env-var SINAWI_MCP_TOKEN
```

```toml
[mcp_servers.sinawi]
url = "http://127.0.0.1:3001/api/app-mcp"
bearer_token_env_var = "SINAWI_MCP_TOKEN"
```

참고: Codex는 기본 도구 타임아웃이 있다. 시나위 도구는 대부분 즉시 돌아오므로 문제 없을 것으로 보지만, 확인하지 않았다 ⚠️.

## 3. Grok Build (그록 쪽 오케스트레이터)

공식 문서: https://docs.x.ai/build/features/mcp-servers , https://docs.x.ai/build/settings — `~/.grok/config.toml`의 `[mcp_servers.<이름>]`, 프로젝트 `.grok/config.toml`. 명령: `grok mcp add|list|remove|enable|disable|doctor`. 📄 (`grok mcp add --help`, grok 1.0.92로 플래그 확인)

> 소유자가 말한 "그록봇"이 Grok Build CLI 위에서 도는 것이라고 보고 썼다. 별도 봇(예: X/Grok 앱의 봇)이라면 그 봇이 MCP 클라이언트를 지원하는지부터 확인해야 한다 ⚠️.
>
> 주의: 시나위 **안의** Grok 담당은 MCP 도구가 없다(README). 이것과 별개로, Grok Build를 **바깥 오케스트레이터**로 두고 시나위에 붙이는 것은 아래처럼 된다.

**A. stdio** ✅ (`grok mcp doctor sinawi` → handshake OK, 79 tools discovered)

```sh
grok mcp add sinawi -- node /Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs
```

```toml
# ~/.grok/config.toml
[mcp_servers.sinawi]
command = "node"
args = ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
enabled = true
```

**B. HTTP** ✅ (`grok mcp doctor` → handshake OK, 79 tools. 헤더의 `${VAR}`가 환경 변수로 바뀌었다)

```sh
export SINAWI_MCP_TOKEN="$(cat "$HOME/Library/Application Support/dev.sinawi.app/.data/app-mcp-token")"
grok mcp add sinawi http://127.0.0.1:3001/api/app-mcp -H 'Authorization: Bearer ${SINAWI_MCP_TOKEN}'
```

```toml
[mcp_servers.sinawi]
url = "http://127.0.0.1:3001/api/app-mcp"
enabled = true

[mcp_servers.sinawi.headers]
Authorization = "Bearer ${SINAWI_MCP_TOKEN}"
```

참고: `grok mcp doctor`는 `~/.claude.json`, `.mcp.json`도 읽는다고 출력에 나온다(Claude Code 구성과 호환). 공식 문서의 타임아웃 기본값: `startup_timeout_sec` 30, `tool_timeout_sec` 6000.

## 4. Claude Desktop

공식 문서: https://modelcontextprotocol.io/docs/develop/connect-local-servers , https://support.claude.com/en/articles/10949351 — macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, 설정 → 개발자 → 구성 편집, 경로는 절대 경로, 바꾼 뒤 완전히 재시작. 📄

가장 쉬움: 시나위 **설정 → 외부 AI 연결 → Claude Desktop 탭 → Claude Desktop에 연결**(앱이 JSON을 보여 주고 합쳐 쓰며 `.bak`을 남김. `server/mcp-clients.ts`).

직접 넣을 때:

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
    }
  }
}
```

`command`는 `which node`의 결과로 바꾼다. 이 환경에서 Claude Desktop 실제 연결은 시험하지 않았다(사용자 실제 구성 파일을 건드리지 않기 위해). 형식은 시나위의 "연결" 버튼이 쓰는 것과 같다.

## 5. Cursor

공식 문서: https://cursor.com/docs/mcp — 전역 `~/.cursor/mcp.json`, 프로젝트 `.cursor/mcp.json`, `mcpServers` 객체, `command`/`args`/`env`, 원격은 `url`(+`headers`). `command`·`args`·`env`·`url`·`headers`에서 변수 치환. 📄

가장 쉬움: 시나위 설정의 **Cursor에 연결** 버튼. 직접 넣을 때는 Claude Desktop과 같은 `mcpServers.sinawi` 항목. 실제 연결 미시험.

## 6. 그 밖의 흔한 MCP 클라이언트

### Gemini CLI 📄

https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md — `~/.gemini/settings.json`(사용자) 또는 `.gemini/settings.json`(프로젝트)의 `mcpServers`. stdio는 `command`/`args`/`env`, Streamable HTTP는 `httpUrl`(+`headers`).

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "node",
      "args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
    }
  }
}
```

또는 `gemini mcp add -s user sinawi node /Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs` ⚠️(플래그 순서는 `gemini mcp add --help`로 확인할 것). 실제 연결 미시험.

### VS Code (GitHub Copilot 에이전트 모드) 📄

https://code.visualstudio.com/docs/agents/reference/mcp-configuration — 최상위 키가 `mcpServers`가 아니라 **`servers`**, `type: "stdio"`. 최신 문서는 `.vscode/mcp.json`을 호환용으로 남긴 위치라고 하고 사용자 프로필 쪽 위치를 권한다(명령 팔레트 "MCP: Add Server" 사용 권장).

```json
{
  "servers": {
    "sinawi": {
      "type": "stdio",
      "command": "node",
      "args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]
    }
  }
}
```

### GitHub Copilot CLI 📄

https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers — `~/.copilot/mcp-config.json`, 최상위 `mcpServers`, 로컬은 `"type": "local"`(문서상 `stdio`도 호환 이름).

```json
{
  "mcpServers": {
    "sinawi": {
      "type": "local",
      "command": "node",
      "args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"],
      "tools": ["*"]
    }
  }
}
```

`"tools": ["*"]`는 ⚠️(필수 여부를 문서에서 끝까지 확인하지 못함).

### opencode 📄

https://opencode.ai/docs/mcp-servers — 버전에 따라 형식이 다르다. V1(`/v1/docs`): `opencode.json`의 `mcp.<이름>`에 `type: "local"`, `command`는 **배열**, 환경 변수는 `environment`. V2 문서는 `mcp.servers` 아래로 옮기고 `disabled` 필드를 쓴다고 한다. 아래는 V1 형식:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sinawi": {
      "type": "local",
      "command": ["node", "/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"],
      "enabled": true
    }
  }
}
```

V2 형식은 문서 일부만 확인해 정확한 예시를 쓰지 않았다 ⚠️. 실제 연결 미시험.

---

## 7. 오케스트레이터에게 붙여 줄 사용법

바깥 AI의 시스템 프롬프트·스킬·AGENTS.md에 넣어 "시나위에 일을 맡기는 법"을 알려 주는 문안. 앱의 **설정 → 외부 AI 연결 → 바깥 AI에게 줄 사용법**에도 같은 글이 있고 복사 버튼이 있다. 도구 이름은 `server/app-tools.ts` 기준.

```text
코딩 작업은 직접 하지 말고 시나위(MCP 서버 "sinawi")에 맡긴다. 사람은 시나위 앱에서 그 대화를 보고 끼어든다.
1. list_leads로 프로젝트 담당을 찾는다. 없으면 create_lead로 만든다.
2. create_session(lead_id, prompt, title)으로 그 담당의 새 채팅을 연다. 특정 에이전트·모델이 필요하면 agent(claude|codex|grok)와 model을 준다. 비우면 담당 설정을 쓴다.
3. wait_for_session(session_id)으로 답을 기다린다. done이 false면 다시 부른다. 다음부터는 after_event_id에 lastEventId를 넣어 새 메시지만 받는다.
4. 이어서 시킬 일은 send_message(session_id, prompt) 다음 wait_for_session.
5. 사람이 같은 채팅에 직접 말했을 수 있다. messages의 from을 보고 따른다.
6. [승인 필요] 도구는 pending_approval을 돌려준다. 같은 요청을 다시 보내지 말고 사용자에게 시나위에서 승인하라고 알린다.
7. 사용자에게 보여 줄 채팅은 show_session(session_id)으로 앱에 띄운다.
```

## 8. 검증 방법 (재현용)

실제 앱·데이터를 건드리지 않고 확인한 방법:

```sh
# 임시 데이터 폴더와 다른 포트로 서버
npm ci
SINAWI_PORT=3027 SINAWI_DATA_DIR="$(mktemp -d)" node --import tsx server/index.ts

# 클라이언트도 임시 설정 폴더로
GROK_HOME=$(mktemp -d) grok mcp add sinawi -e SINAWI_URL=http://127.0.0.1:3027 -e SINAWI_DATA_DIR=<위 폴더> -- node packages/sinawi/lib/mcp.mjs
GROK_HOME=<같은 폴더> grok mcp doctor sinawi
CLAUDE_CONFIG_DIR=$(mktemp -d) claude mcp add sinawi -s user -e SINAWI_URL=... -e SINAWI_DATA_DIR=... -- node packages/sinawi/lib/mcp.mjs
CLAUDE_CONFIG_DIR=<같은 폴더> claude mcp list
CODEX_HOME=$(mktemp -d) codex mcp add ... && codex mcp list   # 형식만 확인
```

결과 요약: stdio 브리지 `initialize`(2025-06-18)·`tools/list`(79개) 정상. Claude Code 2.1.328: stdio·HTTP 모두 Connected. Grok Build 1.0.92: stdio·HTTP 모두 handshake OK·79 tools. Codex 0.169.1: 구성 작성·목록 표시까지만.

## 출처

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex MCP: https://developers.openai.com/codex/mcp
- Grok Build MCP: https://docs.x.ai/build/features/mcp-servers , https://docs.x.ai/build/settings
- Claude Desktop: https://modelcontextprotocol.io/docs/develop/connect-local-servers , https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- Cursor: https://cursor.com/docs/mcp
- Gemini CLI: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- VS Code: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- GitHub Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- opencode: https://opencode.ai/docs/mcp-servers
