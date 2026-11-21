# 프로젝트 담당과 MCP

[English](mcp.md) · 전체 도구 목록: [mcp-coverage.md](mcp-coverage.md)

## 프로젝트 담당

담당은 프로젝트 하나를 맡아 오래 이어 가는 채팅입니다. 사이드바 맨 위 **담당**의 **+** 로 만들고, 그 채팅에서 말로 계속 일을 맡기면 됩니다. 담당은 알게 된 것을 노트에 적고 지난 대화를 찾아보며, 대화가 길어지면 새 세션으로 넘어가 노트로 이어 갑니다. 노트·지침·스킬·팀·병합 정책·일정은 담당 설정에서 고칩니다.

담당은 워크스페이스에 속합니다. 이름은 그 워크스페이스 안에서 고유하므로 서로 다른 공간에서는 같은 이름을 쓸 수 있습니다. API와 MCP에서 이름으로 찾을 때는 호출자의 워크스페이스를 먼저 찾고, 다른 여러 공간에 같은 이름이 있으면 담당 ID를 써야 합니다. 담당끼리 묻기는 같은 워크스페이스 안에서만 됩니다.

### 병합 정책

| 정책 | 워커가 끝낸 브랜치 |
|---|---|
| `auto` | 턴이 끝날 때 메인 폴더에 병합합니다. |
| `ask` (기본) | 담당 패널에서 승인할 때까지 작업 브랜치에 남습니다. |
| `never` | 작업 브랜치에 그대로 둡니다. |

### 담당 도구 (`sinawi_lead`)

Claude·Codex 담당은 자기 실행에서 MCP 서버 `sinawi_lead`를 받습니다(*Plan* 모드 제외). 언제 도구를 쓸지는 담당이 고르며 키워드 규칙은 없습니다.

- **병렬 위임.** `delegate_task`는 워커에게 일을 맡기고 바로 `task_id`를 돌려줍니다. 여러 번 부르면 동시에 돌고(같은 CLI도 워커가 따로 생김), `check_task`로 상태를, `collect_results`로 결과를 기다려 받습니다.
- **디자인 작업.** `delegate_task`에 `kind: "design"`을 주면 워커가 화면을 브라우저로 열어 스크린샷을 보고에 붙입니다.
- **스킬 작성.** `write_skill`·`update_skill`·`list_skills`로 반복할 작업 지침을 이 담당 전용 또는 프로젝트 전체(`.claude/skills`)에 남기고 다음 브리프에 붙입니다.
- **일정 자동 생성.** `schedule_create`·`schedule_list`·`schedule_update`(지우는 `schedule_delete`는 승인 필요)로 대화에서 정한 마감·점검·반복 작업을 담당이 직접 일정으로 만듭니다.
- **앱 도구.** 아래 앱 전체 도구도 함께 씁니다.
- **다른 담당에게 묻기.** 같은 워크스페이스의 담당에게만 물을 수 있습니다. 공간을 넘겨 협업하려면 먼저 한 담당을 같은 공간으로 옮겨야 합니다.

### 일정

정한 시각에 담당 채팅으로 메시지를 보냅니다. 1회(`at`) 또는 반복(5칸 cron, 예: `0 9 * * 1-5`)이며, 시각은 일정의 IANA 시간대 기준입니다(기본은 이 Mac의 시간대, 예: `Asia/Seoul`). 앱이 꺼져 있는 동안 놓친 실행은 조금 늦은 정도면 한 번 돌고, 오래 지난 것은 건너뜁니다. 담당 설정에서 직접 추가·수정·끄기·삭제할 수 있고, 만들거나 바뀌거나 실행된 일정은 다음 실행 시각과 함께 채팅에 카드로 보입니다.

### Grok 담당

Grok Build에는 실행마다 MCP를 붙이는 옵션이 없어, Grok 담당은 MCP 대신 텍스트 태그(`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`)를 씁니다. `sinawi_lead` 도구를 못 쓰므로 병렬 `delegate_task`, 스킬 작성, 일정, 앱 도구가 없습니다. 이런 기능이 필요하면 Claude나 Codex를 담당으로 두세요.

## 앱 전체 MCP (외부 AI)

시나위는 기능을 MCP 서버로도 내놓아 다른 AI가 지휘를 맡을 수 있습니다. Claude Code, Codex, Grok Build, Claude Desktop, Cursor 등 MCP 클라이언트가 담당 아래 채팅을 열고, 특정 채팅에 일을 보내고, 에이전트와 모델을 고르고, 결과를 기다려 읽습니다. 이렇게 열린 채팅은 앱에 클라이언트 이름과 함께 실시간으로 보이고, 사용자가 이어서 말할 수 있습니다. 같은 서버로 담당·일정·작업 공간·그룹·봇·알림·스킬·설정도 다룹니다.

### 연결

시나위가 켜져 있어야 합니다. **설정 → 외부 AI 연결**을 열어 클라이언트를 고르고 보이는 내용을 복사하세요. 경로와 포트는 내 Mac에 맞게 채워져 있습니다. 앱이 `/Applications`에 있으면 이런 모양입니다:

| 클라이언트 | 방법 |
|---|---|
| Claude Code | `claude mcp add sinawi --scope user -e SINAWI_URL=http://127.0.0.1:3001 -e SINAWI_MCP_TOKEN_FILE=<토큰 파일> -- <node> <브리지>` |
| Codex | `codex mcp add sinawi --env SINAWI_URL=… --env SINAWI_MCP_TOKEN_FILE=… -- <node> <브리지>`, 또는 화면에 나오는 `[mcp_servers.sinawi]` 블록을 `~/.codex/config.toml`에 |
| Grok Build | `grok mcp add sinawi -e SINAWI_URL=… -e SINAWI_MCP_TOKEN_FILE=… -- <node> <브리지>`, 확인은 `grok mcp doctor sinawi` |
| Claude Desktop, Cursor | **Claude Desktop에 연결** / **Cursor에 연결** 버튼이 대신 써 줍니다(아래) |
| 그 밖 | **그 밖의 MCP** 탭의 `mcpServers` JSON |

`<브리지>`는 `<데이터 폴더>/hooks/sinawi-mcp.mjs`에 있는 브리지 사본으로, 앱을 옮기거나 업데이트해도 그대로입니다(`/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs`도 됩니다). `<node>`는 앱이 쓰는 Node, `<토큰 파일>`은 `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`입니다. 토큰은 파일에서 읽기 때문에 구성에 토큰이 복사되지 않고, 다시 만든 토큰도 그대로 동작합니다. 그다음 클라이언트를 다시 시작하거나 새 세션을 여세요.

**Claude Desktop·Cursor는 버튼 하나.** 버튼을 누르면 넣을 JSON을 그대로 보여 주고, **구성에 쓰기**를 누르면 `~/Library/Application Support/Claude/claude_desktop_config.json` 또는 `~/.cursor/mcp.json`에 합칩니다(없으면 만들고, 다른 키와 서버는 그대로 두고, 원래 파일은 `<파일>.bak`으로 복사하고, 올바른 JSON이 아닌 파일은 건드리지 않음). 그다음 클라이언트를 다시 시작하세요:

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

이 버튼은 MCP 도구가 아니고, 쓰기는 앱 자신의 창에서 사용자가 확인한 JSON으로만 받습니다. AI가 다른 AI 클라이언트의 구성을 바꿀 수 없습니다.

**npm 패키지가 게시된 뒤에는** `<node> <브리지>` 대신 `npx -y @rakmlabs/sinawi mcp`를 써도 됩니다. 아직 게시 전이라 지금은 `npx`가 404를 냅니다. 위 명령을 쓰세요.

모두 같은 파일 `packages/sinawi/lib/mcp.mjs`를 실행합니다. 저장소에서는 `npm run sinawi-mcp`도 같습니다. 환경변수는 [패키지 README](../packages/sinawi/README.md)에, 클라이언트별 안내는 [docs/mcp-clients.md](mcp-clients.md)에 있습니다.

### 담당에게 일 맡기기

지휘하는 AI의 보통 흐름:

1. `list_leads` — 담당(프로젝트 주인)과 폴더 목록.
2. `create_session`에 `lead_id`, `prompt`, 필요하면 `agent`(`claude`, `codex`, `grok`)와 `model` — 그 담당 아래 새 채팅을 열고 시작합니다. 담당의 폴더·지침·메모리는 모든 채팅이 함께 씁니다.
3. `wait_for_session`에 채팅 id — 이번 턴이 끝나면(또는 `timeout_sec`가 지나면) 상태, 담당의 마지막 답, 그사이 메시지를 줍니다. `done`이 false면 아직 실행 중이니 `after_event_id`에 `lastEventId`를 넣어 다시 부릅니다.
4. 이어서 하려면 같은 채팅에 `send_message`, 동시에 돌리려면 `create_session`을 한 번 더.
5. `show_session`은 앱 창에서 그 채팅을 열어 사용자에게 보여 줍니다.

앱에서는 이 채팅이 담당 아래 탭으로 보이고 연 클라이언트 이름이 붙습니다. 사용자는 언제든 읽고 끼어들 수 있습니다.

### npm 패키지 `@rakmlabs/sinawi`

아직 게시 전입니다. 게시되면 `npx @rakmlabs/sinawi`가 앱을 설치하거나 업데이트하고(최신 GitHub 릴리즈를 `codesign --verify --deep --strict`와 `spctl -a -t exec`로 확인하고, `/Applications/Sinawi.app`을 바꾸기 전에 묻습니다), `npx @rakmlabs/sinawi mcp`가 브리지입니다. 배포는 손으로 합니다. `packages/sinawi/package.json` 버전을 올린 뒤 **Actions → Publish sinawi (npm) → Run workflow**를 실행합니다(`.github/workflows/publish-sinawi.yml`, `NPM_TOKEN` 시크릿으로 `npm publish --provenance --access public`). `npm run pkg:pack`은 묶일 파일을 보여 주고, `npm run pkg:publish`는 로그인된 컴퓨터에서 provenance 없이 배포합니다.

### 토큰

토큰은 `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`(권한 0600)에 있습니다. 서버는 `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → 기본 경로 순서로 찾고 호출마다 다시 읽습니다. **설정 → 외부 AI 연결**의 **토큰 다시 만들기**를 누르면 이전 토큰은 바로 거부됩니다.

### 승인

- **즉시 실행:** 읽기, 생성(채팅·담당·워크스페이스·그룹·봇·일정·알림), 메시지 보내기, 이름 바꾸기.
- **승인 필요:** 삭제, 설정·정책 변경, 병합 승인/거절, 실행 멈춤, 맥락 압축, 워커 빼기, 터미널 명령, 채팅·그룹을 다른 워크스페이스로 옮기기(그 공간의 전체 권한·컴퓨터 조작 정책을 얻게 되므로). 이런 호출은 `pending_approval`을 돌려주고 앱에 승인 카드가 뜨며, **승인**을 누르기 전에는 실행되지 않습니다. AI는 `list_approvals`로 결과를 읽습니다.
- 생성 도구도 위험한 값은 막습니다: AI가 만든 채팅은 *Plan*·*Auto*로만 돌고 *Full access*를 받지 않으며, 새 담당은 `auto` 병합으로 시작할 수 없습니다.

### 알려진 한계

승인은 **MCP 도구 표면**의 경계입니다. 시나위 로컬 HTTP API는 이 Mac의 비브라우저 클라이언트에 열려 있어, 셸을 가진 에이전트가 HTTP를 직접 부르면 승인 카드를 거치지 않습니다. 전체 셸 권한은 믿을 수 있는 에이전트에만 주세요.
