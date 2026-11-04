# 시나위 MCP 도구 커버리지

시나위의 기능을 MCP 도구로 내놓아, 담당(프로젝트 리드)과 외부 AI가 키워드 규칙 없이 도구 설명을 보고 직접 골라 쓰게 합니다.

- 레지스트리: `server/app-tools.ts` (`APP_TOOLS`, `ROUTE_EXCLUSIONS`) 한 곳. 담당 전용 도구(예전 `lead-tools.ts`의 `LEAD_TOOLS`)도 여기로 합쳤습니다.
- 실행: 앱 도구는 정의에 적힌 HTTP 라우트의 **기존 핸들러를 프로세스 안에서 그대로 호출**합니다(`injectRequest`). 검증·저장·화면 갱신이 UI와 같고 로직을 다시 짜지 않습니다. 담당 전용 도구는 `Orchestra.leadToolCall`로 갑니다.
- 검사: `server/app-tools.test.ts`가 실제 서버의 Express 라우트 목록을 뽑아, 모든 라우트가 도구나 사유 있는 제외 중 하나를 갖는지, 도구·제외가 없는 라우트를 가리키지 않는지 확인합니다. 새 라우트를 추가하면 이 테스트가 실패합니다.

## 두 표면

| 표면 | 엔드포인트 | 인증 | 누가 |
|---|---|---|---|
| 담당 (`sinawi_lead`) | `POST /api/lead-mcp` | 담당 실행의 토큰(`x-sinawi-token`), 담당 본인 실행만 | 담당 CLI 실행(Claude/Codex). 담당 전용 도구 + 앱 도구 |
| 외부 (`sinawi`) | `POST /api/app-mcp` | 데이터 폴더의 `app-mcp-token`(0600)을 `Authorization: Bearer`로 | stdio 브리지(`sinawi mcp`, `packages/sinawi`)를 띄우는 Claude Desktop, Cursor 등. 앱 도구만 |

담당 전용 도구(`delegate_task`, `collect_results` 등)는 담당의 진행 중인 턴이 필요해 외부에는 없습니다. 일정은 담당이 자기 `schedule_*` 도구를 쓰고, 외부에는 담당 ID를 받는 `*_lead_schedule` 도구가 있습니다.

## 승인(pending approval)

`risk: "approval"` 도구는 부르면 실행되지 않고 `{"status":"pending_approval","approvalId":"…"}`를 돌려줍니다. MCP `tools/list`에도 `annotations.destructiveHint: true`와 설명 끝의 "[승인 필요]"로 표시됩니다.

1. `app-approvals.json`에 대기 요청이 저장되고(재시작해도 남음), 알림(권한 종류)과 채팅 화면의 **승인 카드(승인/거절)** 가 뜹니다. 담당이 요청했으면 그 담당 채팅에 "승인 대기" 이벤트도 남습니다.
2. 사용자가 **승인**하면 그때 도구를 실행하고 결과(또는 실패 사유)를 기록합니다: 결과 알림 + 담당 채팅 이벤트. **거절**하면 실행하지 않습니다. 한 요청은 한 번만 처리됩니다(두 번째는 409).
3. AI는 `list_approvals(approval_id)`로 상태(`pending/approved/rejected/failed`)와 결과를 읽습니다.

승인 대상: 삭제(채팅·담당·워크스페이스·그룹·봇·일정·worktree·알림 비우기), 설정 변경(배정 설정, 워크스페이스 기본값·정책, 지금 워크스페이스, MCP/스킬 켜기·끄기, 담당 설정·병합 정책, 사용자 선호, 채팅 팀·자동 전환·담당 모드), 병합 승인/거절, 채팅·그룹을 다른 워크스페이스로 옮기기(그 공간의 전체 권한·컴퓨터 조작 정책을 얻는 경로), 실행 멈춤, 맥락 압축, 워커 빼기, 터미널 명령 실행·닫기.
즉시 실행: 읽기, 생성(채팅·담당·워크스페이스·그룹·봇·일정·알림), 메시지 보내기, 이름 바꾸기·채팅을 그룹에 넣고 빼기, 다시 읽기(refresh), 컴퓨터 조작 멈춤(안전 방향).

생성이어도 위험한 값은 막습니다: `create_session`/`send_message`의 `permission_mode`는 plan/auto만(전체 권한은 사용자가 앱에서). `create_session`·`start_bot_conversation`은 비우면 auto로 보내, 전체 권한이 켜진 워크스페이스에서도 AI가 만든 채팅이 전체 권한을 물려받지 않습니다. `list_tools`는 MCP 서버의 명령줄·URL(키가 들어 있을 수 있음)을 빼고 돌려줍니다, `create_lead`의 `merge_policy`는 ask/never만(auto는 승인이 필요한 `update_lead`로).

참고: 시나위 로컬 HTTP API는 원래 이 컴퓨터의 비브라우저 클라이언트에 열려 있습니다. 승인은 **MCP 도구 표면**의 경계이며, 셸을 가진 에이전트가 HTTP를 직접 부르는 것까지 막지는 않습니다.

## 도구 (89개)

| 라우트 | 도구 | 실행 | 표면 | 설명 |
|---|---|---|---|---|
| Orchestra.leadToolCall (담당 턴) | `delegate_task` | 생성/변경 · 즉시 | 담당만 | 워커(Claude/Codex/Grok CLI)에게 일을 맡기고 바로 task_id를 돌려받는다. |
| Orchestra.leadToolCall (담당 턴) | `check_task` | 읽기 · 즉시 | 담당만 | 맡긴 일의 상태(running/done/error/stopped)를 본다. |
| Orchestra.leadToolCall (담당 턴) | `collect_results` | 읽기 · 즉시 | 담당만 | 맡긴 일의 결과를 받는다. |
| Orchestra.leadToolCall (담당 턴) | `write_skill` | 생성/변경 · 즉시 | 담당만 | 재사용할 스킬(작업 지침 문서)을 만든다. |
| Orchestra.leadToolCall (담당 턴) | `update_skill` | 생성/변경 · 즉시 | 담당만 | write_skill로 만든 스킬의 설명이나 본문을 고친다. |
| Orchestra.leadToolCall (담당 턴) | `list_skills` | 읽기 · 즉시 | 담당만 | 이 담당이 워커 브리프에 붙일 수 있는 스킬(담당 스킬, 프로젝트 스킬)을 본다. |
| Orchestra.leadToolCall (담당 턴) | `schedule_create` | 생성/변경 · 즉시 | 담당만 | 이 담당의 일정을 만든다. |
| Orchestra.leadToolCall (담당 턴) | `schedule_list` | 읽기 · 즉시 | 담당만 | 이 담당의 일정 목록(ID, 시각, 반복, 켜짐)과 지금 시각·시간대. |
| Orchestra.leadToolCall (담당 턴) | `schedule_update` | 생성/변경 · 즉시 | 담당만 | 이 담당의 일정을 고치거나 끄고 켠다(enabled). |
| Orchestra.leadToolCall (담당 턴) | `schedule_delete` | **승인 필요** | 담당만 | 이 담당의 일정을 지운다. |
| `GET /api/bootstrap` | `app_overview` | 읽기 · 즉시 | 담당·외부 | 시나위 전체 모습: 설치된 에이전트 CLI(Codex/Claude/Grok)와 사용 가능 여부, 켜진 스킬, 봇, 프로젝트 그룹, 기본 폴더. |
| `GET /api/health` | `app_status` | 읽기 · 즉시 | 담당·외부 | 시나위 서버 상태: 버전, 실행 중인 채팅 수, 열린 앱 창 수. |
| `GET /api/setup` | `get_setup_status` | 읽기 · 즉시 | 담당·외부 | 이 컴퓨터의 준비 상태: Node/Git/에이전트 CLI 설치 여부, macOS 권한(전체 디스크 접근 등). |
| `GET /api/workspaces` | `list_workspaces` | 읽기 · 즉시 | 담당·외부 | 워크스페이스(공간) 목록, 지금 워크스페이스, 공간별 기본값(폴더·팀·허용 에이전트)과 정책, 실행 중 채팅 수. |
| `GET /api/sessions` | `list_sessions` | 읽기 · 즉시 | 담당·외부 | 채팅(세션) 목록: ID, 제목, 상태(running/done/error/stopped), 에이전트, 폴더, 담당 여부. |
| `GET /api/sessions` | `get_session` | 읽기 · 즉시 | 담당·외부 | 채팅 하나의 정보와 최근 메시지·이벤트(답변, 도구 실행, 오류). |
| `GET /api/sessions/:id/summary` | `get_session_summary` | 읽기 · 즉시 | 담당·외부 | 채팅 한눈에 보기: 상태, 담당의 마지막 답, 체크리스트 진행, 승인 기다리는 병합, 담당 정보. |
| `POST /api/sessions` | `create_session` | 생성/변경 · 즉시 | 담당·외부 | 새 채팅을 연다. prompt가 있으면 바로 시작, 없으면 빈 채팅. workers·agent를 비우면 담당 팀 → 워크스페이스 기본 팀 → 허용 에이전트. |
| `POST /api/sessions/:id/messages` | `send_message` | 생성/변경 · 즉시 | 담당·외부 | 채팅에 이어서 메시지를 보낸다(다음 턴 시작). |
| `POST /api/sessions/:id/live` | `ask_running_session` | 생성/변경 · 즉시 | 담당·외부 | 실행 중인 채팅에 진행을 멈추지 않고 곁가지 질문을 한다("지금 어디까지 했어?"). |
| `PATCH /api/sessions/:id` | `rename_session` | 생성/변경 · 즉시 | 담당·외부 | 채팅 제목을 바꾼다. |
| `PATCH /api/sessions/:id/group` | `move_session_to_group` | 생성/변경 · 즉시 | 담당·외부 | 채팅을 프로젝트 그룹에 넣거나(group_id) 그룹에서 뺀다(group_id 비움). |
| `PATCH /api/sessions/:id/workspace` | `move_session_to_workspace` | **승인 필요** | 담당·외부 | 채팅을 다른 워크스페이스(공간)로 옮긴다. 옮긴 채팅은 그 공간의 정책을 따른다. |
| `POST /api/sessions/:id/stop` | `stop_session` | **승인 필요** | 담당·외부 | 실행 중인 채팅을 멈춘다. |
| `POST /api/sessions/:id/compact` | `compact_session` | **승인 필요** | 담당·외부 | 긴 채팅의 맥락을 요약으로 줄인다(이전 대화는 요약만 남음). |
| `DELETE /api/sessions/:id` | `delete_session` | **승인 필요** | 담당·외부 | 채팅을 지운다(실행 중이면 안 됨). |
| `PATCH /api/sessions/:id/team` | `set_session_team` | **승인 필요** | 담당·외부 | 채팅의 팀(주 에이전트, 모델, 워커)을 바꾼다. |
| `PATCH /api/sessions/:id/auto-switch` | `set_session_auto_switch` | **승인 필요** | 담당·외부 | 채팅의 자동 전환(메시지마다 맞는 에이전트로 바꾸기)을 켜거나 끈다. |
| `DELETE /api/sessions/:id/workers/:workerId` | `remove_session_worker` | **승인 필요** | 담당·외부 | 채팅 팀에서 워커 하나를 뺀다(그 워커의 대화 기록도 빠짐). |
| `GET /api/sessions/:id/worktrees` | `list_worktrees` | 읽기 · 즉시 | 담당·외부 | 채팅의 워커별 git worktree와 상태(브랜치, 커밋 수, 커밋 안 된 변경). |
| `DELETE /api/sessions/:id/worktrees/:workerId` | `delete_worktree` | **승인 필요** | 담당·외부 | 워커의 git worktree를 지운다. |
| `POST /api/sessions/:id/merge/approve` | `approve_merge` | **승인 필요** | 담당·외부 | 담당 채팅에서 승인을 기다리는 워커 브랜치 병합을 승인해 프로젝트에 합친다. |
| `POST /api/sessions/:id/merge/reject` | `reject_merge` | **승인 필요** | 담당·외부 | 승인을 기다리는 병합을 거절한다(브랜치는 합쳐지지 않음). |
| `GET /api/stewards` | `list_leads` | 읽기 · 즉시 | 담당·외부 | 프로젝트 담당 목록: 이름, 팀, 병합 정책(auto/ask/never), 폴더, 일일 보고 시각. |
| `GET /api/stewards/:id` | `get_lead` | 읽기 · 즉시 | 담당·외부 | 담당 하나의 설정, 노트(담당이 기억하는 것), 스레드(채팅) 목록. |
| `POST /api/stewards` | `create_lead` | 생성/변경 · 즉시 | 담당·외부 | 프로젝트 담당을 만든다. |
| `PATCH /api/stewards/:id` | `update_lead` | **승인 필요** | 담당·외부 | 담당 설정(이름, 지침, 팀, 병합 정책, 폴더, 노트, 보고 시각)을 바꾼다. |
| `DELETE /api/stewards/:id` | `delete_lead` | **승인 필요** | 담당·외부 | 담당을 지운다. |
| `GET /api/sessions/:id/steward` | `get_session_lead` | 읽기 · 즉시 | 담당·외부 | 담당 채팅의 담당 상태: 담당, 노트, 대기 병합, 턴 수, 보고 시각, 다른 담당 목록. |
| `PATCH /api/sessions/:id/steward` | `update_session_lead` | **승인 필요** | 담당·외부 | 채팅의 담당 모드를 켜고 끄거나, 이름·보고 시각·'다른 담당의 부탁으로 작업하기'(accept_work)를 바꾼다. |
| `GET /api/stewards/settings` | `get_lead_settings` | 읽기 · 즉시 | 담당·외부 | 앱 전체 담당 설정: 이전된 담당이 받는 기본 병합 정책. |
| `PUT /api/stewards/settings` | `set_legacy_merge_policy` | **승인 필요** | 담당·외부 | 이전된(옛 방식) 담당들의 기본 병합 정책을 auto/ask로 정한다. |
| `POST /api/stewards/merge-policy/bulk` | `set_all_merge_policies` | **승인 필요** | 담당·외부 | 모든 담당의 병합 정책을 한 번에 바꾼다. |
| `GET /api/stewards/:id/schedules` | `list_lead_schedules` | 읽기 · 즉시 | 외부만 | 담당의 일정 목록(정한 시각에 담당 채팅으로 메시지가 감). |
| `POST /api/stewards/:id/schedules` | `create_lead_schedule` | 생성/변경 · 즉시 | 외부만 | 담당에게 일정을 만든다. |
| `PATCH /api/schedules/:id` | `update_lead_schedule` | 생성/변경 · 즉시 | 외부만 | 담당의 일정을 고치거나 끄고 켠다(enabled). |
| `DELETE /api/schedules/:id` | `delete_lead_schedule` | **승인 필요** | 외부만 | 담당의 일정을 지운다. |
| `GET /api/user-preferences` | `get_user_preferences` | 읽기 · 즉시 | 담당·외부 | 모든 담당이 읽는 사용자 선호(user-preferences.md): 말투, 작업 방식, 하지 말 것. |
| `PUT /api/user-preferences` | `set_user_preferences` | **승인 필요** | 담당·외부 | 사용자 선호 전체를 새 글로 바꾼다(덮어씀). |
| `POST /api/workspaces` | `create_workspace` | 생성/변경 · 즉시 | 담당·외부 | 워크스페이스(공간)를 만든다. |
| `PATCH /api/workspaces/:id` | `rename_workspace` | 생성/변경 · 즉시 | 담당·외부 | 워크스페이스(공간) 이름을 바꾼다. |
| `PATCH /api/workspaces` | `switch_workspace` | **승인 필요** | 담당·외부 | 앱에서 지금 보는 워크스페이스를 바꾼다. |
| `PATCH /api/workspaces` | `update_workspace_settings` | **승인 필요** | 담당·외부 | 워크스페이스의 기본값(defaults: 폴더 cwd, 팀 agent/workers, 허용 에이전트 allowedAgents, 한도 자동 전환 quotaFallback 등 — 통째로 바뀜)이나 정책(policy: 미디어 생성, 컴퓨터 조작, 전체 권한, 차단 도구 등 — 준 값만 합쳐짐)을 바꾼다. |
| `DELETE /api/workspaces/:id` | `delete_workspace` | **승인 필요** | 담당·외부 | 워크스페이스를 지운다. |
| `GET /api/groups` | `list_groups` | 읽기 · 즉시 | 담당·외부 | 프로젝트 그룹(사이드바에서 채팅을 묶는 폴더) 목록: ID, 이름, 워크스페이스. |
| `POST /api/groups` | `create_group` | 생성/변경 · 즉시 | 담당·외부 | 프로젝트 그룹(채팅 묶음)을 만든다. |
| `PATCH /api/groups/:id` | `rename_group` | 생성/변경 · 즉시 | 담당·외부 | 프로젝트 그룹(채팅 묶음)의 이름을 바꾼다. |
| `PATCH /api/groups/:id/workspace` | `move_group_to_workspace` | **승인 필요** | 담당·외부 | 프로젝트 그룹을 안의 채팅과 함께 다른 워크스페이스로 옮긴다. 옮긴 채팅은 그 공간의 정책을 따른다. |
| `DELETE /api/groups/:id` | `delete_group` | **승인 필요** | 담당·외부 | 프로젝트 그룹을 지운다(채팅은 그룹 밖으로 남음). |
| `POST /api/bots` | `create_bot` | 생성/변경 · 즉시 | 담당·외부 | 봇(이름·에이전트·지침을 가진 캐릭터)을 만든다. |
| `DELETE /api/bots/:id` | `delete_bot` | **승인 필요** | 담당·외부 | 봇(이름·지침을 가진 캐릭터)을 지운다. |
| `POST /api/conversations` | `start_bot_conversation` | 생성/변경 · 즉시 | 담당·외부 | 두 봇이 주제를 두고 정한 턴만큼 대화하는 채팅을 연다. |
| `GET /api/notifications` | `list_notifications` | 읽기 · 즉시 | 담당·외부 | 앱 알림(로그인 필요, 한도, 권한 질문, 작업 완료, 담당 보고, 오류). |
| `POST /api/notifications` | `notify_user` | 생성/변경 · 즉시 | 담당·외부 | 사용자에게 앱 알림(안내)을 띄운다. |
| `POST /api/notifications/read` | `mark_notifications_read` | 생성/변경 · 즉시 | 담당·외부 | 알림을 읽음으로 표시한다(ids 또는 all). |
| `DELETE /api/notifications` | `clear_notifications` | **승인 필요** | 담당·외부 | 워크스페이스의 알림을 모두 지운다. |
| `GET /api/skills` | `list_installed_skills` | 읽기 · 즉시 | 담당·외부 | 폴더 기준으로 쓸 수 있는(켜진) 스킬 목록: 이름, 설명, 출처. |
| `POST /api/skills/refresh` | `refresh_skills` | 읽기 · 즉시 | 담당·외부 | 스킬을 디스크에서 다시 읽는다(새로 설치한 스킬이 안 보일 때). |
| `GET /api/tools` | `list_tools` | 읽기 · 즉시 | 담당·외부 | 에이전트별 MCP 도구와 스킬, 켜짐 여부와 인증 필요 여부(도구 관리 화면). |
| `PUT /api/tools/mcp` | `set_mcp_tool_enabled` | **승인 필요** | 담당·외부 | 에이전트의 MCP 서버를 이 워크스페이스에서 켜거나 끈다(CLI 설정도 바뀜). |
| `PUT /api/tools/skill` | `set_skill_enabled` | **승인 필요** | 담당·외부 | 스킬을 이 워크스페이스에서 켜거나 끈다. |
| `GET /api/settings` | `get_settings` | 읽기 · 즉시 | 담당·외부 | 배정(라우팅) 설정: 분석 모델, 에이전트별 모델 목록과 로그인 상태, 배정 규칙. |
| `POST /api/settings/models/refresh` | `refresh_models` | 읽기 · 즉시 | 담당·외부 | 에이전트 CLI의 모델 목록과 로그인 상태를 다시 확인한다. |
| `PUT /api/settings` | `update_routing_settings` | **승인 필요** | 담당·외부 | 배정 설정 전체를 저장한다. |
| `POST /api/route` | `recommend_team` | 읽기 · 즉시 | 담당·외부 | 할 일에 맞는 팀(주 에이전트, 워커, 모델)을 앱의 분석기로 추천받는다. |
| `GET /api/usage` | `get_usage` | 읽기 · 즉시 | 담당·외부 | 최근 실행별 토큰·비용 사용량(에이전트, 모델, 채팅, 역할별). |
| `GET /api/limits` | `get_limits` | 읽기 · 즉시 | 담당·외부 | 에이전트별 사용 한도(남은 비율, 초기화 시각). |
| `POST /api/limits/refresh` | `refresh_limits` | 읽기 · 즉시 | 담당·외부 | Claude 사용 한도를 지금 다시 확인한다. |
| `GET /api/files` | `search_files` | 읽기 · 즉시 | 담당·외부 | 폴더 안 파일을 이름으로 찾는다(.gitignore 따름). |
| `GET /api/directories` | `list_directories` | 읽기 · 즉시 | 담당·외부 | 폴더 안 하위 폴더 목록(작업 폴더 고를 때). |
| `GET /api/permissions` | `list_permission_requests` | 읽기 · 즉시 | 담당·외부 | 실행 중인 에이전트가 사용자 답을 기다리는 권한 질문 목록(답은 사용자가 앱에서 함). |
| `GET /api/computer/state` | `computer_use_status` | 읽기 · 즉시 | 담당·외부 | 컴퓨터 조작 상태: 허락된 채팅, 진행 중인 조작. |
| `POST /api/computer/stop` | `stop_computer_use` | 생성/변경 · 즉시 | 담당·외부 | 진행 중인 컴퓨터 조작(마우스·키보드)을 모두 멈춘다. |
| `GET /api/preview/ports` | `list_preview_ports` | 읽기 · 즉시 | 담당·외부 | 이 컴퓨터에서 열려 있는 개발 서버 포트(미리보기 대상). |
| `GET /api/sim-view/devices` | `list_simulators` | 읽기 · 즉시 | 담당·외부 | 이 Mac의 iOS 시뮬레이터 기기 목록(UDID, 이름, 켜짐 여부). |
| `GET /api/terminal` | `list_terminals` | 읽기 · 즉시 | 담당·외부 | 앱의 통합 터미널 목록(ID, 폴더, 실행 중 여부). |
| `POST /api/terminal/:id/run` | `run_in_terminal` | **승인 필요** | 담당·외부 | 앱 통합 터미널에서 명령을 실행한다. |
| `DELETE /api/terminal/:id` | `close_terminal` | **승인 필요** | 담당·외부 | 통합 터미널을 닫는다(그 안의 프로세스도 끝남). |
| `GET /api/app-approvals` | `list_approvals` | 읽기 · 즉시 | 담당·외부 | 승인 요청 목록과 결과. |

## 제외한 라우트 (41개)

| 라우트 | 이유 |
|---|---|
| `POST /api/lead-mcp` | MCP 엔드포인트 자체(담당 실행의 sinawi_lead). |
| `POST /api/app-mcp` | MCP 엔드포인트 자체(외부 AI용 브리지 `sinawi mcp`). |
| `GET /api/app-mcp/connection` | 외부 연결 토큰을 보여 주는 설정 화면용. AI에게 토큰을 주지 않는다. |
| `POST /api/app-mcp/token` | 외부 연결 토큰 재발급(설정 화면 버튼). AI가 자기 연결을 바꾸면 안 된다. |
| `GET /api/app-mcp/clients/:client` | Claude Desktop·Cursor 연결 미리보기(설정 화면 버튼). 다른 앱의 구성 파일을 다루는 일이라 도구가 아니다. |
| `POST /api/app-mcp/clients/:client` | Claude Desktop·Cursor 구성 파일에 sinawi 항목을 쓴다(설정 화면에서 사용자가 확인한 뒤에만, 앱 Origin 필요). AI가 다른 AI 클라이언트의 도구 구성을 바꾸면 안 된다. |
| `POST /api/app-approvals/:id/approve` | 사용자만 하는 결정. AI가 자기 승인 요청을 승인하면 승인의 의미가 없다. |
| `POST /api/app-approvals/:id/reject` | 사용자만 하는 결정(승인 카드의 거절 버튼). |
| `POST /api/permissions/request` | Claude 실행 내부의 권한 질문 MCP가 실행 토큰으로 부르는 경로. |
| `POST /api/permissions/:id/answer` | 권한 질문에 대한 사용자의 답. AI가 대신 답하면 안 된다. |
| `POST /api/browser/result` | 앱 창이 브라우저 명령 결과를 돌려주는 내부 경로. |
| `POST /api/browser/:action` | 실행 토큰이 필요한 앱 브라우저 브리지. 에이전트는 orchestra-browser 스킬(ao-browser)로 쓴다. |
| `POST /api/computer/result` | 앱 창이 컴퓨터 조작 결과를 돌려주는 내부 경로. |
| `POST /api/computer/revoke` | 사용자가 컴퓨터 조작 허락을 거두는 버튼. AI가 허락 상태를 바꾸지 않는다. |
| `GET /api/computer/activity` | 컴퓨터 조작 기록 화면용. 요약은 computer_use_status. |
| `GET /api/computer/image/:name` | 조작 스크린샷 이미지 파일(바이너리). |
| `POST /api/computer/:action` | 실행 토큰과 macOS 승인 창이 필요한 컴퓨터 조작. 에이전트는 orchestra-computer 스킬(ao-computer)로 쓴다. |
| `GET /api/link-preview` | 채팅 링크 카드 렌더링 보조. |
| `POST /api/open-external` | 사용자 기본 브라우저로 URL을 여는 화면 동작. AI가 임의 URL을 열지 않게 뺀다. |
| `POST /api/preview/open` | 앱 미리보기 창의 프록시 열기(화면 동작). |
| `GET /api/preview/native-script` | 앱 미리보기 창에 주입하는 스크립트. |
| `GET /api/preview/native-page-script` | 앱 미리보기 창에 주입하는 스크립트. |
| `POST /api/preview/assets` | 미리보기 화면 캡처 업로드(화면 내부). |
| `POST /api/preview/assets/raw` | 미리보기 화면 캡처 업로드(바이너리). |
| `POST /api/serve/:op` | 실행 토큰이 필요한 개발 서버 관리. 에이전트는 ao-serve CLI로 쓴다. |
| `POST /api/sim/:op` | 실행 토큰이 필요한 시뮬레이터 조작. 에이전트는 ao-sim CLI로 쓴다. |
| `GET /api/sessions/:id/file` | 채팅 첨부 파일 내용(바이너리 스트림, 화면 표시용). |
| `POST /api/sessions/:id/file/open` | Finder나 기본 앱으로 파일을 여는 화면 동작. |
| `GET /api/preview/file` | 미리보기 파일 내용(바이너리, 화면 표시용). |
| `POST /api/preview/file/open` | Finder나 기본 앱으로 파일을 여는 화면 동작. |
| `POST /api/directories/pick` | Finder 폴더 선택 창(사용자가 직접 고르는 대화상자). |
| `POST /api/sessions/:id/live/promote` | 곁가지 답 카드의 '채팅에 넣기' 버튼(그 카드의 이벤트 ID가 필요한 화면 동작). |
| `POST /api/sessions/:id/handoff/undo` | 자동 전환 카드의 되돌리기 버튼(그 카드의 이벤트 ID가 필요한 화면 동작). |
| `POST /api/sessions/:id/quota/return` | 한도 전환 배너의 '원래 에이전트로' 버튼(그 배너의 이벤트 ID가 필요한 화면 동작). |
| `POST /api/sessions/:id/worktrees/:workerId/open` | Finder로 worktree 폴더를 여는 화면 동작. |
| `POST /api/setup/open-settings` | macOS 시스템 설정 창을 여는 화면 동작. |
| `POST /api/sim-view/boot` | 시뮬레이터 창 화면 스트림(화면 동작). |
| `GET /api/sim-view/frame` | 시뮬레이터 화면 프레임(바이너리 스트림). |
| `POST /api/sim-view/capture` | 시뮬레이터 창 캡처(화면 동작). |
| `POST /api/sim-view/input` | 시뮬레이터 창의 마우스 입력(화면 동작). 에이전트는 ao-sim으로 조작한다. |
| `POST /api/terminal/external` | macOS Terminal.app을 여는 화면 동작. |
| `GET /health` | /api/health와 같은 내용(app_status). |
| `GET /{*path}` | 앱 화면(정적 파일). |


## 서버 라우트가 없는 UI 기능 (도구 대상 아님)

| 기능 | 이유 |
|---|---|
| 테마·글꼴·글자 크기·언어 (설정 → 모양/일반) | 브라우저 localStorage에만 있는 화면 설정. 서버 상태가 없음 |
| 알림 토스트 종류 고르기 (설정 → 알림) | localStorage 화면 설정 |
| 끝까지 진행(autoRun) 기본값 (설정 → 일반) | localStorage 기본값. 채팅마다는 `create_session.auto_run`으로 정함 |
| 단축키, 온보딩 다시 보기, 업데이트 확인 | 화면·앱(Tauri) 동작 |
| 앱 브라우저 탭·시뮬레이터 창·터미널 창 UI | 화면. 에이전트는 orchestra-browser/ao-sim 스킬, 터미널 명령은 `run_in_terminal` |
| 보관(archive) | 지금 시나위에 보관 기능이 없음(삭제만 있음 → `delete_session`, 승인 필요) |

## Claude Desktop·Cursor 연결

1. 가장 쉬운 방법: 시나위 설정 → 일반 → **외부 AI 연결 (MCP)** 에서 **Claude Desktop에 연결** 또는 **Cursor에 연결**을 누릅니다. 넣을 JSON을 확인하면 앱이 클라이언트 구성 파일에 `mcpServers.sinawi`를 합칩니다(다른 항목 유지, 원본은 `.bak`). 항목은 `<데이터 폴더>/hooks/sinawi-mcp.mjs`를 앱의 Node로 실행하고 토큰은 `SINAWI_MCP_TOKEN_FILE`로 읽습니다. 클라이언트를 다시 시작하세요.
2. 직접 넣으려면 같은 화면의 **구성 복사**를 누릅니다. 토큰이 들어간 `npx -y sinawi mcp` 구성이 나옵니다(npm 패키지 `sinawi`가 올라간 뒤부터 동작). npx 없이 쓰는 구성도 함께 나옵니다. Claude Desktop → 설정 → 개발자 → 구성 편집으로 `claude_desktop_config.json`을 열고 `mcpServers`에 넣습니다:

```json
{
  "mcpServers": {
    "sinawi": {
      "command": "npx",
      "args": ["-y", "sinawi", "mcp"],
      "env": { "SINAWI_URL": "http://127.0.0.1:3001", "SINAWI_MCP_TOKEN": "<설정 화면의 토큰>" }
    }
  }
}
```

3. npm 없이: `node "/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs"`(앱에 든 브리지). 클라이언트를 다시 시작합니다. 시나위 앱이 켜져 있어야 합니다.

저장소에서는 `npm run sinawi-mcp` 또는 `node scripts/sinawi-mcp.mjs`로 같은 서버를 띄웁니다(구현은 `packages/sinawi/lib/mcp.mjs` 하나). 토큰은 `SINAWI_MCP_TOKEN` → `SINAWI_MCP_TOKEN_FILE` → `$SINAWI_DATA_DIR/app-mcp-token` → `~/Library/Application Support/dev.sinawi.app/.data/app-mcp-token` 순서로 찾습니다(호출마다 다시 읽음). 설정 화면의 **토큰 다시 만들기**를 누르면 이전 토큰은 바로 거부됩니다.
