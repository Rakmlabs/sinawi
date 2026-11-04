# 프로젝트 담당과 MCP

[English](mcp.md) · 전체 도구 목록: [mcp-coverage.md](mcp-coverage.md)

## 프로젝트 담당

담당은 프로젝트 하나를 맡아 오래 이어 가는 채팅입니다. 사이드바 맨 위 **담당**의 **+** 로 만들고, 그 채팅에서 말로 계속 일을 맡기면 됩니다. 담당은 알게 된 것을 노트에 적고 지난 대화를 찾아보며, 대화가 길어지면 새 세션으로 넘어가 노트로 이어 갑니다. 노트·지침·스킬·팀·병합 정책·일정은 담당 설정에서 고칩니다.

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

### 일정

정한 시각에 담당 채팅으로 메시지를 보냅니다. 1회(`at`) 또는 반복(5칸 cron, 예: `0 9 * * 1-5`)이며, 시각은 일정의 IANA 시간대 기준입니다(기본은 이 Mac의 시간대, 예: `Asia/Seoul`). 앱이 꺼져 있는 동안 놓친 실행은 조금 늦은 정도면 한 번 돌고, 오래 지난 것은 건너뜁니다. 담당 설정에서 직접 추가·수정·끄기·삭제할 수 있고, 만들거나 바뀌거나 실행된 일정은 다음 실행 시각과 함께 채팅에 카드로 보입니다.

### Grok 담당

Grok Build에는 실행마다 MCP를 붙이는 옵션이 없어, Grok 담당은 MCP 대신 텍스트 태그(`<<DELEGATE>>`, `<<NOTES>>`, `<<ASK>>`, `<<CHECKLIST>>`)를 씁니다. `sinawi_lead` 도구를 못 쓰므로 병렬 `delegate_task`, 스킬 작성, 일정, 앱 도구가 없습니다. 이런 기능이 필요하면 Claude나 Codex를 담당으로 두세요.

## 앱 전체 MCP (외부 AI)

시나위는 기능을 MCP 서버로도 내놓아 Claude Desktop 같은 외부 AI가 채팅·담당·일정·워크스페이스·그룹·봇·알림·스킬·설정 등을 다룰 수 있습니다.

### Claude Desktop 연결

1. 시나위 **설정 → 일반 → 외부 AI 연결 (MCP)** 에서 **구성 복사**를 누릅니다. 앱이 `<데이터 폴더>/hooks/sinawi-mcp.mjs`를 써 두고 토큰이 들어간 구성을 보여 줍니다.
2. Claude Desktop **설정 → 개발자 → 구성 편집**으로 `claude_desktop_config.json`을 열어 `mcpServers`에 넣습니다:

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "/path/to/node",
      "args": ["/Users/<you>/Library/Application Support/dev.sinawi.app/.data/hooks/sinawi-mcp.mjs"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<설정 화면의 토큰>" }
    }
  }
}
```

3. Claude Desktop을 다시 시작합니다. 시나위가 켜져 있어야 합니다.

저장소에서는 `npm run sinawi-mcp`(또는 `node scripts/sinawi-mcp.mjs`)로 같은 stdio 서버를 띄웁니다.

### 토큰

토큰은 `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token`(권한 0600)에 있습니다. 서버는 `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → 기본 경로 순서로 찾고 호출마다 다시 읽습니다. 같은 설정 화면의 **토큰 다시 만들기**를 누르면 이전 토큰은 바로 거부됩니다.

### 승인

- **즉시 실행:** 읽기, 생성(채팅·담당·워크스페이스·그룹·봇·일정·알림), 메시지 보내기, 이름 바꾸기.
- **승인 필요:** 삭제, 설정·정책 변경, 병합 승인/거절, 실행 멈춤, 맥락 압축, 워커 빼기, 터미널 명령, 채팅·그룹을 다른 워크스페이스로 옮기기(그 공간의 전체 권한·컴퓨터 조작 정책을 얻게 되므로). 이런 호출은 `pending_approval`을 돌려주고 앱에 승인 카드가 뜨며, **승인**을 누르기 전에는 실행되지 않습니다. AI는 `list_approvals`로 결과를 읽습니다.
- 생성 도구도 위험한 값은 막습니다: AI가 만든 채팅은 *Plan*·*Auto*로만 돌고 *Full access*를 받지 않으며, 새 담당은 `auto` 병합으로 시작할 수 없습니다.

### 알려진 한계

승인은 **MCP 도구 표면**의 경계입니다. 시나위 로컬 HTTP API는 이 Mac의 비브라우저 클라이언트에 열려 있어, 셸을 가진 에이전트가 HTTP를 직접 부르면 승인 카드를 거치지 않습니다. 전체 셸 권한은 믿을 수 있는 에이전트에만 주세요.
