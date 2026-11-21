# 시나위의 자리 — 경쟁 조사와 포지셔닝 초안

> 작성 2026-11-21. 기준 코드: `main`의 `7d58487`(v1.6.8 직후). 병렬로 진행 중인 `sinawi-overhaul` 작업(담당 하나에 채팅 여러 개, 외부 MCP 도구 보강 등)은 반영하지 않았다. 그 작업이 들어가면 4장 "못 미치는 부분"을 다시 봐야 한다.
>
> 원칙: 코드에 없는 기능은 쓰지 않는다. 웹에서 직접 확인한 것만 단정하고, 확인 못 한 것은 그렇다고 적는다. 수치·후기·사용자 수는 쓰지 않는다.

## 1. 시나위가 지금 실제로 하는 것 (코드 확인)

| 사실 | 근거 |
|---|---|
| macOS 앱(Tauri + React + 로컬 Node 서버 `127.0.0.1:3001`). Claude Code·Codex·Grok Build CLI를 사용자의 로그인 그대로 실행한다. API 키를 받지 않는다. | `README.md`, `server/cli.ts`, `server/runtime.ts` |
| 채팅마다 에이전트의 메시지·도구 호출·명령·파일 변경을 실시간으로 화면에 흘린다. 사용자는 같은 채팅에 이어서 말할 수 있다. | `README.md`(Live view), `server/live-turn.ts` |
| **외부 MCP 표면 `sinawi`**: 다른 AI 클라이언트가 stdio 브리지(`packages/sinawi/lib/mcp.mjs`)로 `POST /api/app-mcp`에 붙어 **79개 도구**를 쓴다. `create_session`(채팅 열고 바로 일 시작), `send_message`(이어 말하기), `get_session`·`get_session_summary`(대화·상태 읽기), `ask_running_session`(진행 중 곁가지 질문), `list_leads`·`create_lead` 등. | `server/app-tools.ts`, `server/server.ts:1368`, 임시 서버로 `tools/list` 79개 직접 확인 |
| 그렇게 외부 AI가 연 채팅은 **앱 안의 일반 채팅**이다. 사람이 앱에서 실시간으로 보고, 같은 채팅에 직접 말을 이어갈 수 있다. | `create_session`이 `POST /api/sessions`의 기존 핸들러를 그대로 호출(`injectRequest`) |
| 위험한 도구(삭제·설정 변경·병합·터미널 명령·실행 멈춤 등 28개)는 실행되지 않고 앱에 **승인 카드**를 띄운다. AI가 스스로 승인할 도구는 없다. 외부 AI가 연 채팅은 *Plan*/*Auto*만, *전체 권한*은 불가. | `docs/mcp-coverage.md`, `server/app-approvals.ts` |
| **담당(lead)**: 프로젝트 하나를 오래 맡는 채팅. 노트, 스킬, 일정(cron), 병합 정책, 워커 병렬 위임(`delegate_task`, 각자 git worktree). Claude/Codex 담당만 MCP 도구를 가진다(Grok 담당은 텍스트 태그 방식). | `docs/mcp.md`, `server/orchestra.ts` |
| 공간(workspace)별로 채팅·담당·정책, 선택적으로 CLI 계정 폴더(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`)를 따로 둔다. | `README.md` Spaces |

정리하면 시나위에는 두 얼굴이 있다.
1. **안쪽 오케스트레이터**: 시나위 안의 담당이 워커를 부린다(README가 지금 내세우는 것).
2. **바깥 오케스트레이터의 작업장**: Claude Code·Codex·Grok Build·Claude Desktop·Cursor 같은 바깥 AI가 MCP로 시나위에 채팅을 열고 일을 시키면, 그 대화가 시나위 화면에 남고 사람이 끼어들 수 있다. **소유자가 이 제품을 만든 이유는 2번**인데, README 첫 화면은 1번만 말한다.

## 2. 경쟁·유사 도구 조사

질문: "바깥 오케스트레이터가 MCP로 부린 에이전트의 대화를 사람이 실시간으로 보고, 같은 대화에 이어 말한다"를 이미 하는가?

표기: ✅ 공식 문서로 확인 · ◐ 일부만/문서에 명시 없음 · ❌ 하지 않음(확인) · ? 확인 못 함

| 도구 | 무엇을 하나 | 바깥 AI가 MCP로 에이전트를 부림 | 그 대화를 사람이 실시간으로 봄·이어 말함 | 비고 |
|---|---|---|---|---|
| **Conductor** (Mac 앱) | Claude Code·Codex 등을 worktree마다 병렬 실행하는 Mac 앱 | ✅ 호스팅 MCP `https://api.conductor.build/mcp` (베타). `create_session`, `send_message`, `list_messages`, `cancel_session` 등. OAuth 또는 API 키 | ◐ 대상이 "cloud workspaces"이고, 데스크톱 앱에서 사람이 그 대화를 보는지는 문서에 없음 | **가장 가까운 경쟁자.** 단 클라우드·계정 기반. 시나위는 로컬·계정 없음·사용자 CLI 로그인 그대로 |
| **Vibe Kanban** (BloopAI) | 칸반 보드에서 코딩 에이전트를 이슈·워크스페이스 단위로 실행 | ✅ 로컬 stdio MCP(`npx -y vibe-kanban@latest --mcp`). `start_workspace`, `run_session_prompt`, `get_execution` 등. 실행기: claude-code, codex, gemini, opencode, cursor_agent 등 | ◐ 앱 UI에서 보이는 것으로 추정되나 MCP 문서에 명시 없음 | 2026-04-10 회사(bloop) 종료 발표, "open source and community maintained"로 남음. 이슈·프로젝트 등 원격 기능은 제거 예정이라 공지 |
| **Orca** (stablyai) | 여러 CLI 에이전트를 worktree마다 띄우는 IDE. 오케스트레이션 스킬로 코디네이터가 워커를 부리고, 워커 터미널을 사람이 봄. 모바일 앱 | ❌ MCP가 아니라 Orca 자체 CLI(`orca orchestration …`)와 스킬. 오케스트레이터도 Orca 안에서 돌아야 함 | ✅ 워커 터미널을 그대로 봄(이 문서도 Orca 워커가 작성) | 오케스트레이터가 Orca 밖(예: Claude Desktop)이면 해당 없음 |
| **Claude Squad** | tmux 위 TUI. Claude Code·Codex·Gemini·Aider를 worktree별로 병렬 실행 | ❌ MCP 제어 표면 확인 못 함 | ✅(사람이 직접 띄운 세션만) | AGPL-3.0 |
| **Crystal → Nimbalyst** (Stravu) | Claude Code·Codex 병렬 세션, worktree, 세션 보드(칸반) | ? 외부 MCP 제어 표면 확인 못 함 | ✅(앱에서 띄운 세션) | Crystal은 Nimbalyst로 이어짐 |
| **Agent Deck** | tmux 기반 세션 관리 TUI | ❌ MCP 기능은 "세션에 붙일 MCP 서버 관리" | ✅(직접 띄운 세션) | |
| **Happy Coder / Omnara** | 휴대폰에서 Claude Code·Codex 세션을 보고 조작 | ❌ | ✅ 단, `happy`로 사람이 띄운 세션만 | Omnara 오픈소스판은 유지보수 중단 공지 |
| **Claude Code hooks 관측 대시보드** (disler, agents-observe, Mohano 등) | hook 이벤트를 로컬 대시보드로 실시간 표시. 서브에이전트 포함 | ❌(관측만) | ◐ 보기만, 이어 말하기 없음 | Claude Code 중심. 일부 Codex |
| **PAL(구 Zen) MCP `clink`** | 한 CLI가 MCP로 다른 CLI(gemini/codex/claude)를 서브에이전트로 띄움 | ✅ 바로 이 "MCP로 다른 CLI 부리기" | ❌ 서브 CLI 대화는 결과만 돌아오고 사람이 볼 화면 없음 | 문서가 완화된 권한 플래그(`--yolo` 등)로 띄운다고 경고 |
| **Codex `codex mcp-server`** | Codex를 MCP 도구(`codex`, `codex-reply`)로 노출 | ✅ | ❌ 대화는 호출한 쪽에만 결과로 돌아감 | 최근 문서는 deprecated, App Server 권장 |
| **Claude Code 서브에이전트 / agent teams** | 한 Claude Code 안에서 서브에이전트·팀원(실험) 실행 | ❌ 같은 CLI 안 | ◐ 팀원은 tmux/iTerm2 분할로 보임(3자 자료), 서브에이전트는 결과 위주 | Claude만 |
| **Codex 서브에이전트** | Codex 안에서 병렬 에이전트, `/agent`로 스레드 전환 | ❌ 같은 CLI 안 | ✅ CLI·앱 안에서 스레드 전환해 봄 | Codex만 |
| **Grok Build 서브에이전트** | Grok Build 안에서 병렬 서브에이전트, worktree | ❌ 같은 CLI 안 | ? 대시보드 언급은 3자 블로그뿐 | Grok만 |
| **opencode** | 오픈소스 코딩 에이전트(TUI/서버). MCP 클라이언트 | ? 외부가 opencode 세션을 MCP로 부리는 공식 표면 확인 못 함 | ? | 시나위 입장에선 "시나위에 붙일 수 있는 MCP 클라이언트" 쪽 |

### 결론

- **"여러 에이전트를 한 화면에서 병렬로 돌리기"는 이미 붐비는 시장이다**(Conductor, Orca, Claude Squad, Nimbalyst, Agent Deck…). 시나위가 이걸로 경쟁하면 묻힌다.
- **"MCP로 다른 CLI를 부리기"도 있다**(PAL `clink`, `codex mcp-server`). 그러나 이들은 **대화를 숨긴다** — 오케스트레이터는 결과만 받고 사람은 중간을 못 본다. 소유자가 느낀 불편이 정확히 이것이다.
- **둘을 합친 것**(바깥 오케스트레이터가 MCP로 부리고, 사람은 그 대화를 앱에서 보고 이어 말함)을 공식적으로 하는 곳은 조사 범위에서 **Conductor(호스팅 MCP, 베타)와 Vibe Kanban(로컬 MCP, 회사 종료 후 커뮤니티 유지)** 정도였다. 둘 다 "사람이 그 대화를 앱에서 본다"는 점은 문서에 명시돼 있지 않았다.
- 그 안에서 시나위의 차이: **로컬 전용·계정 없음**, **Claude Code·Codex·Grok Build를 섞어서**, **위험 동작은 앱의 승인 카드**, **오케스트레이터는 아무 MCP 클라이언트나**(Claude Desktop·Cursor 같은 비코딩 클라이언트 포함).

## 3. 시나위만의 자리

### 한 문장

> **시나위는 AI가 MCP로 부리는 Claude Code·Codex·Grok의 대화를 사람이 실시간으로 보고 끼어들 수 있게 해 주는, 내 Mac 안의 작업장이다.**

짧은 변형(저장소 설명·배지용):
- "Watch and join the conversations your AI orchestrator has with Claude Code, Codex and Grok — over MCP, on your Mac."
- "AI가 시킨 일, 이제 보면서 시킨다."

### 누구에게 필요한가 (구체 상황)

1. **Claude Desktop·Cursor를 "지휘자"로 쓰는 사람.** Claude Desktop에서 "이 레포에서 결제 버그 고쳐 줘"라고 하면 Desktop은 직접 코딩하지 못한다. 시나위 MCP의 `create_session`으로 Claude Code나 Codex에 일을 열면, 실제 작업 대화는 시나위 채팅으로 흐르고, 사람은 거기서 "그 파일 말고 저 파일"이라고 바로 끼어든다.
2. **Claude Code/Codex/Grok Build 하나를 오케스트레이터로 두고 다른 CLI를 부리던 사람.** `clink`나 `codex mcp-server`로 부리면 서브 CLI의 대화가 안 보인다. 시나위로 바꾸면 각 작업이 이름 붙은 채팅으로 남아 나중에 다시 읽을 수 있다(`get_session`으로 오케스트레이터도 읽는다).
3. **여러 모델에 같은 일을 시켜 보고 고르는 사람.** 오케스트레이터가 Claude·Codex·Grok에 각각 채팅을 열고, 사람은 세 대화를 나란히 보며 방향이 틀어진 쪽만 바로잡는다.
4. **AI가 위험한 일을 하기 전에 멈추길 원하는 팀/개인.** 바깥 AI가 삭제·병합·터미널 명령을 시도하면 시나위 앱에 승인 카드가 뜨고, 사람이 누르기 전에는 실행되지 않는다.
5. **회사·개인 계정을 나눠 쓰는 사람.** 공간마다 CLI 로그인 폴더를 따로 둘 수 있어, 바깥 오케스트레이터가 어느 공간에 채팅을 여느냐로 어떤 계정이 쓰일지가 갈린다.

### 필요 없는 사람

- 에이전트 하나(예: Claude Code)만 터미널에서 직접 쓰고, 그 화면으로 충분한 사람.
- 병렬 실행·worktree만 필요하고 "바깥 AI가 부린다"는 흐름이 없는 사람 → Conductor·Orca·Claude Squad가 더 단순하다.
- Windows·Linux 사용자, 원격 서버/클라우드에서 에이전트를 돌려야 하는 사람(시나위는 macOS·로컬 전용).
- 샌드박스 격리가 필요한 사람(README FAQ: 시나위는 샌드박스가 아니다).

### 지금 코드 기준으로 그 약속에 못 미치는 부분

| # | 문제 | 근거 | 영향 |
|---|---|---|---|
| 1 | **npm 패키지 `@rakmlabs/sinawi`가 레지스트리에 없다.** 2026-11-21 `npm view`와 `registry.npmjs.org` 모두 404. README·설정 화면의 "구성 복사"·`claude mcp add … npx -y @rakmlabs/sinawi mcp` 안내가 그대로는 실패한다. | 직접 확인 | **가장 급함.** 처음 연결하려는 사람이 막힌다. 게시 전까지는 앱 번들 브리지 경로(`/Applications/Sinawi.app/Contents/Resources/sinawi-mcp.mjs`)를 1순위로 안내해야 함 |
| 2 | 외부 표면에 **"끝날 때까지 기다리기"가 없다.** `send_message`는 바로 돌아오고(서버 instructions: "read progress with get_session"), `collect_results(wait)`·`delegate_task`는 담당 전용. 바깥 오케스트레이터는 `get_session_summary`를 반복 호출(폴링)해야 한다. | `server/app-tools.ts` 852행, coverage 표 | 오케스트레이터가 일찍 끝났다고 착각하거나 호출을 낭비 |
| 3 | **어떤 채팅을 어떤 바깥 AI가 열었는지 표시가 없다.** 외부 호출자 문맥은 `{ surface: "external", workspaceId }`뿐이고, 세션에 출처를 남기는 필드를 찾지 못했다. | `server/server.ts:1375`, 저장소 검색 | "오케스트레이터가 부린 대화를 본다"는 핵심 화면에서 구분이 안 됨 (overhaul 작업 범위일 수 있음) |
| 4 | 외부 호출의 기본 공간은 **그 순간 사용자가 보고 있는 공간**(`currentWorkspace()`). | `server/server.ts:1375` | 사람이 공간을 바꿔 두면 오케스트레이터의 채팅이 엉뚱한 공간·계정으로 감. `workspace_id`를 명시하도록 안내 필요 |
| 5 | 시나위를 **거쳐 간 대화만** 보인다. 오케스트레이터 CLI가 자기 안에서 돌리는 서브에이전트(Codex 서브에이전트, Claude Code 서브에이전트/팀원, Grok 서브에이전트)는 시나위에 나타나지 않는다. | 구조상 | "모든 AI 대화를 본다"고 쓰면 과장. "시나위로 보낸 일의 대화"라고 써야 함 |
| 6 | Grok이 **시나위 안의 담당**이면 MCP 도구가 없다(텍스트 태그 방식). 반대로 Grok Build가 **바깥 오케스트레이터**로 시나위에 붙는 것은 된다(아래 mcp-clients.md에서 실제 연결 확인). | `docs/mcp.md`, 직접 확인 | README의 "Grok은 MCP 안 됨" 문구가 바깥 연결까지 안 되는 것처럼 읽힐 수 있음 |
| 7 | 도구 설명·오류 메시지가 **한국어**다(서버 instructions가 영어로 그렇다고 알림). | `server/app-tools.ts` | 영어권 사용자/모델에 약간의 마찰. 기능에는 지장 없음 |
| 8 | macOS 전용, 앱이 켜져 있어야 함, `127.0.0.1`만. 원격(클라우드 AI) 접속은 로드맵. | README | 클라우드 오케스트레이터(ChatGPT 웹 등)는 못 붙음 |
| 9 | 승인 카드는 **MCP 표면만** 막는다. 셸이 있는 에이전트는 로컬 HTTP API를 직접 부를 수 있다. | README FAQ | "안전" 문구를 쓸 때 이 한계를 같이 적어야 함 |
| 10 | Codex CLI를 바깥 오케스트레이터로 붙였을 때의 **실제 핸드셰이크는 확인 못 했다**(설정 형식만 확인). README 로드맵에도 "Verify Codex leads end to end"가 남아 있다. | mcp-clients.md | 문서에 "검증됨"이라고 쓰지 말 것 |

## 4. 찾아오게 하는 것

### 저장소 설명(GitHub About, 350자 이내)

- 영어 1안: `See and join the conversations your AI has with Claude Code, Codex and Grok. A local macOS app + MCP server: any MCP client (Claude Desktop, Cursor, Claude Code, Codex, Grok Build) opens chats here, you watch live, step in, and approve risky actions.`
- 영어 2안(짧게): `Your AI orchestrator's worker chats, visible. Claude Code, Codex and Grok Build over MCP, live on your Mac, with approval cards.`
- 한국어: `AI가 MCP로 부리는 Claude Code·Codex·Grok의 대화를 실시간으로 보고 끼어드는 macOS 앱.`

### 토픽(GitHub topics, 최대 20개)

`mcp`, `mcp-server`, `model-context-protocol`, `claude-code`, `codex`, `codex-cli`, `grok`, `grok-build`, `multi-agent`, `agent-orchestration`, `ai-agents`, `coding-agents`, `human-in-the-loop`, `agent-observability`, `claude-desktop`, `cursor`, `macos`, `tauri`, `git-worktree`, `llm-tools`

### README 첫 화면 구성 제안 (sinawi-overhaul 워커 참고용, 이 브랜치에서는 고치지 않음)

1. **제목 아래 한 줄**: 지금 "One lead AI. A team of … workers. One chat." → 바깥 오케스트레이터 흐름을 앞에 둔다. 예: "**Your AI hands work to Claude Code, Codex and Grok. Sinawi lets you watch those conversations and step in.**"
2. **바로 아래 그림 한 장**: 왼쪽 Claude Desktop(또는 Claude Code 터미널)에서 "시나위로 Codex에게 이거 시켜" → 오른쪽 시나위 창에 그 Codex 채팅이 실시간으로 흐르고, 사람이 한 줄 끼어드는 장면. 지금 데모 GIF는 "안쪽 담당" 흐름이다.
3. **"Why" 세 문장**: ① MCP로 다른 에이전트를 부리면 그 대화는 안 보인다 ② 시나위는 그 일을 화면의 채팅으로 연다 ③ 사람은 보고, 끼어들고, 위험한 동작은 승인한다.
4. **30초 연결**: 클라이언트별 한 줄(Claude Code `claude mcp add …`, Codex `codex mcp add …`, Grok `grok mcp add …`, Claude Desktop/Cursor는 설정의 버튼). npm 게시 전에는 앱 번들 경로로. 자세한 건 `docs/mcp-clients.md`.
5. **그다음에** 담당·병렬 워커·일정·공간(지금의 Highlights).
6. **"이런 분께 / 이런 분께는 아님"** 짧은 두 목록(3장 내용).
7. 비교 표는 README에 넣지 말고 별도 문서로(경쟁사 이름을 첫 화면에 두면 검색 유입은 늘지만 내용이 빨리 낡는다).

### 사람들이 이 문제를 검색할 때 쓸 말 (README·문서·릴리스 노트에 자연스럽게 넣을 표현)

영어:
- "see what my subagents are doing", "watch Codex conversation called from Claude Code"
- "MCP server to run Claude Code / Codex as a worker", "use Codex from Claude Desktop"
- "orchestrate Claude Code and Codex together", "Claude Code Codex Grok in one app"
- "human in the loop coding agents", "approve agent actions", "agent observability local"
- "multi-agent coding Mac app", "Conductor alternative local", "Vibe Kanban alternative"
- "clink alternative with UI", "codex mcp-server see conversation"

한국어:
- "클로드 코드 코덱스 같이 쓰기", "MCP로 코덱스 부리기", "서브에이전트 대화 보기"
- "AI 에이전트 오케스트레이션 맥 앱", "멀티 에이전트 코딩 툴", "그록 빌드 MCP"

## 출처

- Conductor MCP: https://www.conductor.build/docs/api/mcp · 사이트 https://www.conductor.build/
- Vibe Kanban MCP: https://www.vibekanban.com/docs/integrations/vibe-kanban-mcp-server · 종료 공지 https://vibekanban.com/shutdown , https://vibekanban.com/blog/shutdown · 저장소 https://github.com/BloopAI/vibe-kanban
- Orca: https://github.com/stablyai/orca
- Claude Squad: https://github.com/smtg-ai/claude-squad
- Crystal/Nimbalyst: https://github.com/stravu/crystal , https://nimbalyst.com/crystal
- Agent Deck: https://github.com/asheshgoplani/agent-deck
- Happy: https://github.com/slopus/happy · Omnara: https://github.com/omnara-ai/omnara
- 관측 대시보드: https://github.com/disler/claude-code-hooks-multi-agent-observability , https://github.com/simple10/agents-observe
- PAL MCP `clink`: https://github.com/BeehiveInnovations/pal-mcp-server
- Codex MCP 서버/Agents SDK: https://developers.openai.com/codex/guides/agents-sdk · Codex 서브에이전트: https://developers.openai.com/codex/subagents
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- Grok Build: https://x.ai/cli , https://x.ai/news/grok-build-cli
- opencode MCP: https://opencode.ai/docs/mcp-servers

확인 못 한 것: Conductor 데스크톱 앱이 MCP로 만든 클라우드 세션을 보여 주는지, Vibe Kanban MCP로 시작한 세션이 UI에서 보이는지(추정만), Nimbalyst·opencode의 외부 제어 MCP 유무, Grok Build 서브에이전트 대시보드의 공식 여부. 소유자가 말한 "그록봇"이 Grok Build CLI를 말하는지 별도 봇인지도 확인하지 못했다(이 문서는 Grok Build 기준).
