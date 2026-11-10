# AI 에이전트를 위한 시나위 안내

[English](for-ai.md) · 사람용 문서: [README](../../README.ko.md), [docs/mcp.ko.md](../mcp.ko.md), [docs/mcp-coverage.md](../mcp-coverage.md) (라우트 포함)

MCP로 시나위를 다루거나 코드를 읽는 AI를 위한 짧은 구조적 참고 문서입니다. 모든 내용은 소스에서 확인했고, 도구 표는 `server/app-tools.ts`에서 생성합니다.

## 시나위란

- 이 Mac에 이미 설치된 코딩 에이전트 CLI — **Claude Code**(`claude`), **Codex**(`codex`), **Grok Build**(`grok`) — 를 한 팀으로 돌리는 macOS 앱입니다(Tauri v2 셸 + React UI + 로컬 Node/Express 서버).
- API 키를 저장하지 않습니다. 각 CLI가 자기 로그인을 씁니다.
- 서버는 `127.0.0.1`에서만 열립니다. 설치된 앱은 항상 포트 **3001**을 쓰고, 데이터는 `~/Library/Application Support/dev.sinawi.app/.data`에 있습니다.

## 개념

| 개념 | 코드 | 뜻 |
|---|---|---|
| 채팅(세션) | `Session` (`server/types.ts`), `/api/sessions` | 한 팀과의 대화 하나. 상태 `running`/`done`/`error`/`stopped`. 작업 폴더(`cwd`), 주 에이전트, 워커를 가집니다. |
| 담당(프로젝트 리드) | `Steward` (`server/types.ts`), `/api/stewards` | 프로젝트 하나(`cwds`)를 맡는 오래가는 채팅. 워크스페이스 하나(`workspaceId`)에 속하고, 그 채팅도 모두 그 공간에 있습니다. 노트를 남기고 이전 대화를 찾아보며, 대화가 길어지면 새 세션으로 옮겨 노트에서 이어 갑니다. `report`(`HH:MM`)에 일일 보고를 합니다. 같은 공간의 담당끼리 일을 부탁할 수 있습니다(`accept_work`). |
| 워커 | `workers: AgentSelection[]` | 담당이 브리프를 맡기는 CLI. 동시에 맡긴 일은 병렬로 돌고(같은 CLI 두 건은 워커 둘), 한 워커에게 간 브리프는 차례로 돕니다. 워커는 자기 git worktree에서 일할 수 있습니다. |
| 워크스페이스(공간) | `WorkspaceState`, `/api/workspaces` | 채팅·그룹·담당·기본값을 나눕니다(F1/F2로 전환). 기본값: 폴더, 팀, 허용 에이전트, 한도 자동 전환. 정책(`WorkspacePolicy`): `mediaGeneration`, `computerUse`, `fullAccess`, `grokMcp`, `blockedTools`, `authAlertTools`, `accounts`(`{claude, codex, grok}`: CLI 계정 폴더 절대 경로. 그 공간의 모든 실행에 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`으로 넘깁니다. 비우면 기본 로그인). |
| 프로젝트 그룹 | `/api/groups` | 워크스페이스 안에서 채팅을 묶는 사이드바 폴더. |
| 일정 | `/api/stewards/:id/schedules`, `/api/schedules/:id` | 정한 시각에 담당 채팅으로 prompt를 보냅니다. 한 번(`at`) 또는 반복(5칸 `cron`, 예: `0 9 * * 1-5`), IANA 시간대(기본: 이 Mac의 시간대). |
| 스킬 | `/api/skills`, 담당 `write_skill` | 마크다운 작업 지침. `~/.claude/skills`, `~/.codex/skills`, `~/.codex/prompts`, `~/.grok/skills`, 프로젝트 `./skills`에서 읽습니다. 담당이 만든 스킬은 그 담당 전용이거나, `scope: "project"`면 프로젝트 `.claude/skills`에 저장됩니다. |
| 봇 | `/api/bots` | 프리셋(이름, 에이전트, 모델, 스킬, 지침). 두 봇이 정한 턴만큼 대화할 수 있습니다. |
| 병합 정책 | `MergePolicy = "auto" \| "ask" \| "never"` | 담당의 워커 브랜치가 끝났을 때: `auto`는 턴 끝에 병합, `ask`(기본)는 사용자 승인을 기다림(`pendingMerge`), `never`는 브랜치에 그대로 둠. `create_lead`는 `ask`/`never`만 받고, `auto`는 `update_lead`(승인 필요)로만 정합니다. |
| 권한 모드 | `plan` / `auto` / 전체 권한 | *Plan*은 읽기 전용, *Auto*는 프로젝트 폴더 안에서 편집, *전체 권한*은 CLI 샌드박스를 끄며 워크스페이스 정책이 허용할 때만 됩니다. MCP 도구는 `plan`/`auto`만 받습니다. |
| 승인 | `server/app-approvals.ts`, `/api/app-approvals` | risk가 `approval`인 도구는 불러도 실행되지 않고 `{"status":"pending_approval","approvalId":"…"}`를 돌려줍니다. 앱에 승인 카드가 뜨고 사용자가 **승인**해야 실행됩니다. 결과는 `list_approvals`로 읽습니다(`pending`/`approved`/`rejected`/`failed`). |

## MCP 표면

두 표면은 같은 레지스트리(`server/app-tools.ts`의 `APP_TOOLS`)를 읽습니다. 앱 도구는 앱의 HTTP 라우트 핸들러를 프로세스 안에서 그대로 부르므로 검증·저장이 UI와 같습니다.

| 표면 | 서버 이름 | 엔드포인트 | 인증 | 누가 |
|---|---|---|---|---|
| 담당 | `sinawi_lead` | `POST /api/lead-mcp` | 그 실행의 토큰(`x-sinawi-token`), 담당 본인 실행만 | Claude·Codex 담당의 CLI 실행(*Plan* 모드 제외, Grok 제외). 담당 전용 도구 + 앱 도구. |
| 외부 | `sinawi` | `POST /api/app-mcp` | `Authorization: Bearer <토큰>` (또는 `x-sinawi-mcp-token`) | stdio 브리지(`sinawi mcp`, `packages/sinawi`)를 띄우는 Claude Desktop, Cursor 등 MCP 클라이언트. 앱 도구만. |

### MCP 클라이언트 연결

시나위가 켜져 있어야 합니다. 권장 순서:

1. **앱 안의 버튼**(Claude Desktop, Cursor): **설정 → 일반 → 외부 AI 연결 (MCP) → Claude Desktop에 연결 / Cursor에 연결**. 사용자가 JSON을 확인하면 앱이 `~/Library/Application Support/Claude/claude_desktop_config.json` 또는 `~/.cursor/mcp.json`에 `mcpServers.sinawi`를 합칩니다(다른 항목 유지, `.bak` 사본). 항목은 `"command": "<node>", "args": ["<데이터 폴더>/hooks/sinawi-mcp.mjs"], "env": {"SINAWI_URL": …, "SINAWI_MCP_TOKEN_FILE": "<데이터 폴더>/app-mcp-token"}`입니다(토큰은 복사하지 않음). 경로: `GET`/`POST /api/app-mcp/clients/:client`(`claude`, `cursor`). MCP 도구가 아니고, `POST`는 앱 자신의 Origin과 확인한 JSON이 있어야 합니다. 테스트는 `SINAWI_CLAUDE_DESKTOP_CONFIG`, `SINAWI_CURSOR_MCP_CONFIG`로 경로를 옮깁니다.
2. **npx**(npm 패키지 `@rakmlabs/sinawi`): 같은 화면의 **구성 복사**가 다음을 줍니다.

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "npx",
      "args": ["-y", "@rakmlabs/sinawi", "mcp"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<설정 화면의 토큰>" }
    }
  }
}
```

3. **앱에 든 브리지**: `"command": "node"`, `"args": ["/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"]`, `env`는 같음. 설정 화면의 "npx 없이 쓰는 구성"은 대신 `<데이터 폴더>/hooks/sinawi-mcp.mjs` 사본을 가리킵니다(앱 업데이트·이동 후에도 유지).

저장소에서는 `npm run sinawi-mcp`(= `node scripts/sinawi-mcp.mjs`)로 같은 stdio 브리지를 띄웁니다. 모든 형태가 하나의 구현 `packages/sinawi/lib/mcp.mjs`를 실행하며, 의존성이 없습니다(Node 18 이상). 같은 npm 패키지가 앱도 설치합니다: `npx @rakmlabs/sinawi`(macOS, 최신 릴리즈를 받아 `codesign --verify --deep --strict`와 `spctl -a -t exec`로 확인하고, `/Applications/Sinawi.app`을 바꾸기 전에 묻습니다).

### 브리지 환경변수 (`sinawi mcp`)

| 변수 | 뜻 |
|---|---|
| `SINAWI_URL` | 앱 주소. 기본 `http://127.0.0.1:${SINAWI_PORT:-3001}`. |
| `SINAWI_PORT` | `SINAWI_URL`이 없을 때 쓰는 포트. |
| `SINAWI_MCP_TOKEN` | 토큰 값. |
| `SINAWI_MCP_TOKEN_FILE` | 토큰을 읽을 파일. |
| `SINAWI_DATA_DIR` | 데이터 폴더. `$SINAWI_DATA_DIR/app-mcp-token`에서 토큰을 읽습니다. |

### 토큰

- `<데이터 폴더>/app-mcp-token`에 0600 권한으로 저장되고 처음 쓸 때 만들어집니다(`server/app-mcp.ts`). 기본 경로: `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`.
- 브리지가 찾는 순서: `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → 기본 경로. 호출마다 다시 읽으므로 재발급한 토큰은 클라이언트를 다시 켜지 않아도 됩니다.
- 같은 설정 화면의 **토큰 다시 만들기**(`POST /api/app-mcp/token`)를 누르면 이전 토큰은 바로 거부됩니다. 토큰을 읽거나 바꾸는 MCP 도구는 없습니다.
- 토큰이 없거나 틀리면 `/api/app-mcp`가 HTTP 401을 돌려줍니다.

## 도구

표면: `담당` = `sinawi_lead`, `외부` = `sinawi`. 승인 **필요** = 부르면 `pending_approval`을 돌려주고 사용자가 앱에서 승인해야 실행됩니다. `tools/list`에서는 `annotations.destructiveHint: true`와 설명 끝 "[승인 필요]"로 표시되고, 읽기 도구는 `readOnlyHint: true`입니다.

<!-- tools:start -->
<!-- `npm run docs:ai`가 server/app-tools.ts에서 만든 구간입니다. 손으로 고치지 마세요. -->

도구 89개 (담당 표면 85개, 외부 표면 79개), 그중 승인 필요 30개.

### 담당 전용

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `delegate_task` | 담당만 | 아니오 | 워커(Claude/Codex/Grok CLI)에게 일을 맡기고 바로 task_id를 돌려받는다. 여러 번 부르면 동시에 실행된다. 같은 CLI를 두 번 맡겨도 각자 다른 워커로 병렬 실행된다. 결과는 collect_results로 받는다. 디자인·UI 작업은 kind:'design'. |
| `check_task` | 담당만 | 아니오(읽기) | 맡긴 일의 상태(running/done/error/stopped)를 본다. task_id를 비우면 이번 턴의 모든 일. |
| `collect_results` | 담당만 | 아니오(읽기) | 맡긴 일의 결과를 받는다. wait=true면 끝날 때까지(최대 timeout_sec) 기다린다. 받은 결과는 다시 돌려주지 않는다. |
| `write_skill` | 담당만 | 아니오 | 재사용할 스킬(작업 지침 문서)을 만든다. 같은 종류의 일을 여러 번 맡길 때 브리프 대신 스킬로 남겨 delegate_task의 skills에 붙인다. |
| `update_skill` | 담당만 | 아니오 | write_skill로 만든 스킬의 설명이나 본문을 고친다. |
| `list_skills` | 담당만 | 아니오(읽기) | 이 담당이 워커 브리프에 붙일 수 있는 스킬(담당 스킬, 프로젝트 스킬)을 본다. |
| `schedule_create` | 담당만 | 아니오 | 이 담당의 일정을 만든다. 정한 시각에 prompt가 이 담당의 채팅으로 온다. 대화에서 정해진 마감·점검·반복 작업이 있으면 쓴다. |
| `schedule_list` | 담당만 | 아니오(읽기) | 이 담당의 일정 목록(ID, 시각, 반복, 켜짐)과 지금 시각·시간대. 고치거나 지울 일정의 ID를 찾을 때. |
| `schedule_update` | 담당만 | 아니오 | 이 담당의 일정을 고치거나 끄고 켠다(enabled). |
| `schedule_delete` | 담당만 | **필요** | 이 담당의 일정을 지운다. 사용자 승인 후에 지워진다. |

### 앱 상태

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `app_overview` | 담당·외부 | 아니오(읽기) | 시나위 전체 모습: 설치된 에이전트 CLI(Codex/Claude/Grok)와 사용 가능 여부, 켜진 스킬, 봇, 프로젝트 그룹, 기본 폴더. 처음 무엇이 있는지 볼 때 쓴다. |
| `app_status` | 담당·외부 | 아니오(읽기) | 시나위 서버 상태: 버전, 실행 중인 채팅 수, 열린 앱 창 수. |
| `get_setup_status` | 담당·외부 | 아니오(읽기) | 이 컴퓨터의 준비 상태: Node/Git/에이전트 CLI 설치 여부, macOS 권한(전체 디스크 접근 등). |
| `list_workspaces` | 담당·외부 | 아니오(읽기) | 워크스페이스(공간) 목록, 지금 워크스페이스, 공간별 기본값(폴더·팀·허용 에이전트)과 정책, 실행 중 채팅 수. |

### 채팅(세션)

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_sessions` | 담당·외부 | 아니오(읽기) | 채팅(세션) 목록: ID, 제목, 상태(running/done/error/stopped), 에이전트, 폴더, 담당 여부. 내용은 get_session이나 get_session_summary로 본다. |
| `get_session` | 담당·외부 | 아니오(읽기) | 채팅 하나의 정보와 최근 메시지·이벤트(답변, 도구 실행, 오류). 무슨 말이 오갔는지 읽을 때 쓴다. |
| `get_session_summary` | 담당·외부 | 아니오(읽기) | 채팅 한눈에 보기: 상태, 담당의 마지막 답, 체크리스트 진행, 승인 기다리는 병합, 담당 정보. |
| `create_session` | 담당·외부 | 아니오 | 새 채팅을 연다. prompt를 주면 첫 메시지로 바로 일을 시작하고, 비우면 아무것도 실행하지 않은 빈 채팅만 만든다(나중에 send_message로 보낸다). 담당(lead_id)의 새 스레드로 열면 팀·폴더·워크스페이스는 담당 것을 쓴다. 담당 없이 열면 cwd가 필요하고, agent·workers를 비우면 워크스페이스 기본 팀(없으면 허용된 에이전트)을 쓴다. 어떤 팀이 맞을지 모르면 recommend_team을 먼저 부른다. |
| `send_message` | 담당·외부 | 아니오 | 채팅에 이어서 메시지를 보낸다(다음 턴 시작). 담당 채팅이면 담당이 받는다. 결과는 get_session_summary나 get_session으로 확인한다. |
| `ask_running_session` | 담당·외부 | 아니오 | 실행 중인 채팅에 진행을 멈추지 않고 곁가지 질문을 한다("지금 어디까지 했어?"). 답은 채팅에 따로 붙는다. 호출자와 같은 공간의 채팅에만 물을 수 있다. |
| `rename_session` | 담당·외부 | 아니오 | 채팅 제목을 바꾼다. 사이드바에 보이는 이름이 바뀐다. |
| `move_session_to_group` | 담당·외부 | 아니오 | 채팅을 프로젝트 그룹에 넣거나(group_id) 그룹에서 뺀다(group_id 비움). |
| `move_session_to_workspace` | 담당·외부 | **필요** | 채팅을 다른 워크스페이스(공간)로 옮긴다. 옮긴 채팅은 그 공간의 정책(전체 권한, 컴퓨터 조작 등)을 따르게 되므로 사용자 승인 후 옮긴다. 공간 ID는 list_workspaces. |
| `stop_session` | 담당·외부 | **필요** | 실행 중인 채팅을 멈춘다. 진행 중인 일이 끊기므로 사용자 승인 후 멈춘다. |
| `compact_session` | 담당·외부 | **필요** | 긴 채팅의 맥락을 요약으로 줄인다(이전 대화는 요약만 남음). 되돌릴 수 없어 사용자 승인 후 실행된다. |
| `delete_session` | 담당·외부 | **필요** | 채팅을 지운다(실행 중이면 안 됨). remove_worktrees면 워커 worktree도 정리한다(커밋 안 된 변경이 있으면 남김). 사용자 승인 후 지워진다. |
| `set_session_team` | 담당·외부 | **필요** | 채팅의 팀(주 에이전트, 모델, 워커)을 바꾼다. 실행 중에는 안 된다. 사용자 승인 후 바뀐다. |
| `set_session_auto_switch` | 담당·외부 | **필요** | 채팅의 자동 전환(메시지마다 맞는 에이전트로 바꾸기)을 켜거나 끈다. 설정 변경이라 사용자 승인 후 적용된다. |
| `remove_session_worker` | 담당·외부 | **필요** | 채팅 팀에서 워커 하나를 뺀다(그 워커의 대화 기록도 빠짐). 사용자 승인 후 실행된다. |
| `list_worktrees` | 담당·외부 | 아니오(읽기) | 채팅의 워커별 git worktree와 상태(브랜치, 커밋 수, 커밋 안 된 변경). |
| `delete_worktree` | 담당·외부 | **필요** | 워커의 git worktree를 지운다. force면 커밋 안 된 변경도 버린다. 사용자 승인 후 지워진다. |

### 병합

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `approve_merge` | 담당·외부 | **필요** | 담당 채팅에서 승인을 기다리는 워커 브랜치 병합을 승인해 프로젝트에 합친다. 되돌리기 어려워 사용자 승인 후 병합된다. 무엇이 기다리는지는 get_session_summary의 pendingMerge. |
| `reject_merge` | 담당·외부 | **필요** | 승인을 기다리는 병합을 거절한다(브랜치는 합쳐지지 않음). 사용자 승인 후 실행된다. |

### 담당(프로젝트 리드)

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_leads` | 담당·외부 | 아니오(읽기) | 프로젝트 담당 목록: 이름, 팀, 병합 정책(auto/ask/never), 폴더, 일일 보고 시각, 워크스페이스. 담당 이름은 워크스페이스 안에서 고유하며 다른 공간에서는 같을 수 있다. 기본은 지금 워크스페이스(담당이 부르면 그 담당의 워크스페이스)의 담당만. |
| `get_lead` | 담당·외부 | 아니오(읽기) | 담당 하나의 설정, 노트(담당이 기억하는 것), 스레드(채팅) 목록. |
| `create_lead` | 담당·외부 | 아니오 | 프로젝트 담당을 만든다. 담당은 폴더(cwds)를 맡아 워커에게 일을 나누고 결과를 합친다. 병합 정책은 ask(기본, 병합 전에 사용자에게 물음) 또는 never만 정할 수 있다. auto는 update_lead로(승인 필요). |
| `update_lead` | 담당·외부 | **필요** | 담당 설정(이름, 지침, 팀, 병합 정책, 폴더, 노트, 보고 시각, 워크스페이스)을 바꾼다. 준 값만 바뀐다. workspace_id를 주면 담당과 그 채팅이 모두 그 워크스페이스로 옮겨진다. 사용자 승인 후 적용된다. |
| `delete_lead` | 담당·외부 | **필요** | 담당을 지운다. 그 담당의 채팅은 보통 채팅으로 남는다. 사용자 승인 후 지워진다. |
| `get_session_lead` | 담당·외부 | 아니오(읽기) | 담당 채팅의 담당 상태: 담당, 노트, 대기 병합, 턴 수, 보고 시각, 같은 워크스페이스의 다른 담당 목록. 담당끼리 묻기(ASK)는 같은 워크스페이스 안에서만 된다. |
| `update_session_lead` | 담당·외부 | **필요** | 채팅의 담당 모드를 켜고 끄거나, 이름·보고 시각·'다른 담당의 부탁으로 작업하기'(accept_work)를 바꾼다. 사용자 승인 후 적용된다. |
| `get_lead_settings` | 담당·외부 | 아니오(읽기) | 앱 전체 담당 설정: 이전된 담당이 받는 기본 병합 정책. |
| `set_legacy_merge_policy` | 담당·외부 | **필요** | 이전된(옛 방식) 담당들의 기본 병합 정책을 auto/ask로 정한다. 사용자 승인 후 적용된다. |
| `set_all_merge_policies` | 담당·외부 | **필요** | 모든 담당의 병합 정책을 한 번에 바꾼다. 사용자 승인 후 적용된다. |

### 일정

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_lead_schedules` | 외부만 | 아니오(읽기) | 담당의 일정 목록(정한 시각에 담당 채팅으로 메시지가 감). |
| `create_lead_schedule` | 외부만 | 아니오 | 담당에게 일정을 만든다. at(한 번) 또는 cron(반복) 중 하나. 그 시각에 prompt가 담당 채팅으로 간다. |
| `update_lead_schedule` | 외부만 | 아니오 | 담당의 일정을 고치거나 끄고 켠다(enabled). 준 값만 바뀐다. |
| `delete_lead_schedule` | 외부만 | **필요** | 담당의 일정을 지운다. 끄기만 하려면 update_lead_schedule(enabled:false). 사용자 승인 후 지워진다. |

### 사용자 선호

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `get_user_preferences` | 담당·외부 | 아니오(읽기) | 모든 담당이 읽는 사용자 선호(user-preferences.md): 말투, 작업 방식, 하지 말 것. |
| `set_user_preferences` | 담당·외부 | **필요** | 사용자 선호 전체를 새 글로 바꾼다(덮어씀). get_user_preferences로 읽고 고쳐서 보낸다. 사용자 승인 후 저장된다. |

### 워크스페이스

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `create_workspace` | 담당·외부 | 아니오 | 워크스페이스(공간)를 만든다. 지금 공간의 기본값과 정책을 이어받는다. |
| `rename_workspace` | 담당·외부 | 아니오 | 워크스페이스(공간) 이름을 바꾼다. 기본값·정책은 update_workspace_settings. |
| `switch_workspace` | 담당·외부 | **필요** | 앱에서 지금 보는 워크스페이스를 바꾼다. 사용자 화면이 바뀌므로 승인 후 적용된다. |
| `update_workspace_settings` | 담당·외부 | **필요** | 워크스페이스의 기본값(defaults: 폴더 cwd, 팀 agent/workers, 허용 에이전트 allowedAgents, 한도 자동 전환 quotaFallback 등 — 통째로 바뀜)이나 정책(policy: 미디어 생성, 컴퓨터 조작, 전체 권한, 차단 도구, CLI 계정 폴더 accounts {claude, codex, grok: 절대 경로, 빈 문자열이면 기본 로그인} 등 — 준 값만 합쳐짐)을 바꾼다. list_workspaces로 지금 값을 읽고 고쳐서 보낸다. 사용자 승인 후 적용된다. |
| `delete_workspace` | 담당·외부 | **필요** | 워크스페이스를 지운다. 그 안의 채팅, 그룹, 담당은 move_to(비우면 남은 첫 공간)로 옮겨진다. 실행 중인 채팅이 있으면 안 된다. 사용자 승인 후 지워진다. |

### 프로젝트 그룹

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_groups` | 담당·외부 | 아니오(읽기) | 프로젝트 그룹(사이드바에서 채팅을 묶는 폴더) 목록: ID, 이름, 워크스페이스. |
| `create_group` | 담당·외부 | 아니오 | 프로젝트 그룹(채팅 묶음)을 만든다. 채팅은 move_session_to_group으로 넣는다. |
| `rename_group` | 담당·외부 | 아니오 | 프로젝트 그룹(채팅 묶음)의 이름을 바꾼다. 같은 공간에서 이름은 겹칠 수 없다. |
| `move_group_to_workspace` | 담당·외부 | **필요** | 프로젝트 그룹을 안의 채팅과 함께 다른 워크스페이스로 옮긴다. 옮긴 채팅은 그 공간의 정책(전체 권한, 컴퓨터 조작 등)을 따르게 되므로 사용자 승인 후 옮긴다. |
| `delete_group` | 담당·외부 | **필요** | 프로젝트 그룹을 지운다(채팅은 그룹 밖으로 남음). 사용자 승인 후 지워진다. |

### 봇

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `create_bot` | 담당·외부 | 아니오 | 봇(이름·에이전트·지침을 가진 캐릭터)을 만든다. 봇끼리 대화는 start_bot_conversation. 목록은 app_overview의 bots. |
| `delete_bot` | 담당·외부 | **필요** | 봇(이름·지침을 가진 캐릭터)을 지운다. 사용자 승인 후 지워진다. |
| `start_bot_conversation` | 담당·외부 | 아니오 | 두 봇이 주제를 두고 정한 턴만큼 대화하는 채팅을 연다. |

### 알림

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_notifications` | 담당·외부 | 아니오(읽기) | 앱 알림(로그인 필요, 한도, 권한 질문, 작업 완료, 담당 보고, 오류). |
| `notify_user` | 담당·외부 | 아니오 | 사용자에게 앱 알림(안내)을 띄운다. 끝난 일, 확인이 필요한 일을 알릴 때. |
| `mark_notifications_read` | 담당·외부 | 아니오 | 알림을 읽음으로 표시한다(ids 또는 all). |
| `clear_notifications` | 담당·외부 | **필요** | 워크스페이스의 알림을 모두 지운다. 사용자 승인 후 지워진다. |

### 스킬·도구

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_installed_skills` | 담당·외부 | 아니오(읽기) | 폴더 기준으로 쓸 수 있는(켜진) 스킬 목록: 이름, 설명, 출처. |
| `refresh_skills` | 담당·외부 | 아니오(읽기) | 스킬을 디스크에서 다시 읽는다(새로 설치한 스킬이 안 보일 때). |
| `list_tools` | 담당·외부 | 아니오(읽기) | 에이전트별 MCP 도구와 스킬, 켜짐 여부와 인증 필요 여부(도구 관리 화면). |
| `set_mcp_tool_enabled` | 담당·외부 | **필요** | 에이전트의 MCP 서버를 이 워크스페이스에서 켜거나 끈다(CLI 설정도 바뀜). 사용자 승인 후 적용된다. |
| `set_skill_enabled` | 담당·외부 | **필요** | 스킬을 이 워크스페이스에서 켜거나 끈다. 사용자 승인 후 적용된다. |

### 설정·배정

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `get_settings` | 담당·외부 | 아니오(읽기) | 배정(라우팅) 설정: 분석 모델, 에이전트별 모델 목록과 로그인 상태, 배정 규칙. |
| `refresh_models` | 담당·외부 | 아니오(읽기) | 에이전트 CLI의 모델 목록과 로그인 상태를 다시 확인한다. |
| `update_routing_settings` | 담당·외부 | **필요** | 배정 설정 전체를 저장한다. get_settings로 읽은 객체를 고쳐서 settings로 보낸다. 사용자 승인 후 저장된다. |
| `recommend_team` | 담당·외부 | 아니오(읽기) | 할 일에 맞는 팀(주 에이전트, 워커, 모델)을 앱의 분석기로 추천받는다. create_session 전에 쓴다. |

### 사용량·한도

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `get_usage` | 담당·외부 | 아니오(읽기) | 최근 실행별 토큰·비용 사용량(에이전트, 모델, 채팅, 역할별). 비용이나 많이 쓴 곳을 볼 때. |
| `get_limits` | 담당·외부 | 아니오(읽기) | 에이전트별 사용 한도(남은 비율, 초기화 시각). |
| `refresh_limits` | 담당·외부 | 아니오(읽기) | Claude 사용 한도를 지금 다시 확인한다. |

### 파일·폴더

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `search_files` | 담당·외부 | 아니오(읽기) | 폴더 안 파일을 이름으로 찾는다(.gitignore 따름). |
| `list_directories` | 담당·외부 | 아니오(읽기) | 폴더 안 하위 폴더 목록(작업 폴더 고를 때). |

### 환경

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_permission_requests` | 담당·외부 | 아니오(읽기) | 실행 중인 에이전트가 사용자 답을 기다리는 권한 질문 목록(답은 사용자가 앱에서 함). |
| `computer_use_status` | 담당·외부 | 아니오(읽기) | 컴퓨터 조작 상태: 허락된 채팅, 진행 중인 조작. |
| `stop_computer_use` | 담당·외부 | 아니오 | 진행 중인 컴퓨터 조작(마우스·키보드)을 모두 멈춘다. 안전을 위한 멈춤이라 바로 실행된다. |
| `list_preview_ports` | 담당·외부 | 아니오(읽기) | 이 컴퓨터에서 열려 있는 개발 서버 포트(미리보기 대상). |
| `list_simulators` | 담당·외부 | 아니오(읽기) | 이 Mac의 iOS 시뮬레이터 기기 목록(UDID, 이름, 켜짐 여부). |
| `list_terminals` | 담당·외부 | 아니오(읽기) | 앱의 통합 터미널 목록(ID, 폴더, 실행 중 여부). run_in_terminal에 줄 ID를 찾을 때. |
| `run_in_terminal` | 담당·외부 | **필요** | 앱 통합 터미널에서 명령을 실행한다. 임의 명령이라 사용자 승인 후 실행된다. |
| `close_terminal` | 담당·외부 | **필요** | 통합 터미널을 닫는다(그 안의 프로세스도 끝남). 사용자 승인 후 닫힌다. |

### 승인

| 도구 | 표면 | 승인 | 설명 |
|---|---|---|---|
| `list_approvals` | 담당·외부 | 아니오(읽기) | 승인 요청 목록과 결과. 승인이 필요한 도구가 준 approvalId로 상태(pending/approved/rejected/failed)와 실행 결과를 확인한다. |
<!-- tools:end -->

## HTTP API

- 기본 주소: `http://127.0.0.1:3001` (개발 서버는 `SINAWI_PORT`로 포트를 바꿈, 설치된 앱은 3001 고정). 모든 라우트는 `/api` 아래, 실시간 갱신은 WebSocket `/ws`.
- 접근 제어(`server/server.ts`의 `localGuard`, `server/origin-policy.ts`): `Host`가 루프백(`127.0.0.1`, `localhost`, `::1`)이어야 합니다. `Origin` 헤더가 **없는** 요청(CLI, curl)은 허용되고, 브라우저 요청은 `tauri://localhost` 또는 앱 포트·5188·5198의 `http://127.0.0.1|localhost`에서 와야 합니다. 아니면 403.
- 일반 HTTP API에는 그 밖의 인증이 없습니다. 토큰을 확인하는 곳은 `/api/app-mcp`(Bearer 토큰)와 `/api/lead-mcp`(실행 토큰)뿐입니다.
- 모든 라우트는 MCP 도구가 있거나 사유가 적힌 제외(`ROUTE_EXCLUSIONS`)에 들어 있고, `server/app-tools.test.ts`가 이를 검사합니다. 사용자만 하는 결정(승인 요청 승인, 권한 질문 답, 토큰 재발급)에는 도구가 없습니다.

## 한계

- **Grok 담당은 MCP가 아니라 텍스트 태그 방식입니다.** Grok Build에 실행별 MCP 옵션이 없어서 Grok 담당은 태그(`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`)를 쓰고 `sinawi_lead` 도구가 없습니다: 병렬 `delegate_task`, 스킬, 일정, 앱 도구 모두 없음. 이런 기능은 Claude나 Codex 담당으로 씁니다.
- ***Plan* 모드 담당 실행에는 `sinawi_lead`가 붙지 않습니다**(읽기 전용 실행에는 서버를 주지 않음).
- **승인은 MCP 표면만 지킵니다.** 로컬 HTTP API는 이 Mac의 비브라우저 클라이언트에 열려 있으므로, 셸을 가진 에이전트는 HTTP를 직접(예: curl) 불러 승인 카드를 건너뛸 수 있습니다. 전체 셸 권한은 믿을 수 있는 에이전트에게만 주세요.
- 생성 도구도 위험한 값은 막습니다: `permission_mode`는 `plan`/`auto`만(전체 권한은 사용자가 앱에서 켬), `create_session`·`start_bot_conversation`은 비우면 `auto`, `create_lead`는 `auto` 병합을 정할 수 없음, `list_tools`는 MCP 서버의 실행 정보(명령, URL, env, 헤더)를 뺍니다.
- 담당 전용 도구(`delegate_task`, `collect_results` 등)는 담당의 진행 중인 턴이 필요해 외부 표면에는 없습니다. 외부 클라이언트는 `lead_id`를 받는 `*_lead_schedule` 도구로 일정을 다룹니다.
- 앱 창 동작(Finder 열기, 앱 브라우저, 스크린샷)은 MCP 도구가 아닙니다. 에이전트는 실행 토큰과 함께 `orchestra-browser`/`orchestra-computer` 스킬(`ao-browser`, `ao-computer`)로 앱 브라우저와 컴퓨터 조작을 씁니다.
- macOS 전용입니다.
