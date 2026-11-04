# 시나위 (Sinawi)

[English](README.md)

시나위는 이미 설치해 둔 코딩 에이전트 CLI, 즉 **Codex**, **Claude Code**, **Grok Build**를 한 팀으로 묶어 실행하는 macOS 앱입니다. 에이전트 하나가 총괄을 맡아 계획을 세우고 일을 나눠 다른 에이전트(작업자)에게 맡깁니다. 진행 과정은 실시간으로 보이고, 언제든 끼어들 수 있습니다.

이름은 즉흥 합주를 뜻하는 우리 음악 용어 '시나위'에서 따왔습니다.

## 왜 만들었나

CLI마다 잘하는 일이 다릅니다. 한 에이전트가 다른 에이전트에게 일을 맡기면 하나만 쓸 때보다 결과가 좋은 경우가 많지만, 손으로 하려면 터미널 여러 개를 오가며 출력을 옮겨야 합니다. 시나위가 그 조율을 맡습니다. 요청을 배정하고, 위임 지시서를 쓰고, 작업자를 실행하고, 보고를 확인하고, 전 과정을 화면에 보여 줍니다.

## 할 수 있는 일

- **총괄과 작업자.** 총괄과 작업자 조합을 직접 고르거나, **자동** 배정으로 요청에 맞는 팀·모델·스킬을 추천받습니다. 총괄은 목표·맥락·완료 기준·제약·검증·보고 형식을 갖춘 지시서로 위임하고, 빠진 칸은 앱이 채웁니다. 요약 과정에서 빠지는 게 없도록 사용자의 원문도 함께 붙이고, 결과는 총괄에게 돌려줍니다. 총괄이 여러 작업자에게 일을 나누면 동시에 실행되고, 한 작업자에게 준 일은 순서대로 실행됩니다.
- **프로젝트 담당.** 담당은 프로젝트 하나를 맡아 오래 이어 가는 채팅입니다. 그 채팅에서 계속 일을 맡기면 되고, 담당은 노트(담당 설정에서 고침)를 남기며 세션이 바뀌어도 이어 갑니다. Claude·Codex 담당은 `sinawi_lead` MCP 도구로 병렬 위임(`delegate_task`, `check_task`, `collect_results`), 스킬 작성, 스크린샷이 붙어 오는 디자인 작업, 일정 자동 생성을 합니다. 병합 정책은 담당마다 `auto`·`ask`·`never` 중 고릅니다. Grok 담당은 MCP 대신 텍스트 태그를 써서 이 도구들이 없습니다.
- **일정.** 1회 또는 cron 반복이며 Mac의 시간대(예: `Asia/Seoul`) 기준입니다. 담당이 대화에서 직접 만들고, 사용자는 담당 설정에서 관리하며, 일정마다 채팅에 카드로 보입니다.
- **앱 전체 MCP.** Claude Desktop 같은 외부 AI가 `npm run sinawi-mcp`와 **설정 → 일반 → 외부 AI 연결**의 토큰으로 시나위를 다룹니다. 읽기·생성은 바로 실행되고, 위험한 도구는 앱의 승인 카드를 기다립니다. 자세한 내용은 [docs/mcp.ko.md](docs/mcp.ko.md).
- **권한 모드** (Claude Code와 같은 방식): **계획**(읽기만 하고 계획을 제안, 버튼 하나로 바로 실행), **자동**(프로젝트 폴더 안에서 수정하고, 평범한 명령은 되묻지 않음. Claude Code는 CLI 자체의 자동 모드를 씀), **전체 권한**(작업 공간에서 허용한 경우에만).
- **실시간 화면.** 메시지, 도구 호출, 명령, 파일 변경이 바로 보이고, 지금 팀이 무엇을 하는지(CI나 배포를 기다리는 중인지까지) 표시합니다.
- **작업 공간.** 대화·프로젝트·기본 설정을 공간별로 나눕니다(F1 / F2로 전환). 공간마다 쓸 수 있는 에이전트, 컴퓨터 조작·전체 권한 허용 여부, 막을 MCP 도구를 정합니다.
- **한도 소진 시 자동 전환.** 한 CLI의 한도가 거의 차면 설정한 순서대로 다음 에이전트로 넘깁니다.
- **앱 내 브라우저와 컴퓨터 조작.** 에이전트가 앱 안 브라우저를 조작하고(스냅샷·클릭·입력·스크린샷), macOS 권한을 주면 다른 네이티브 앱도 다룹니다. 세션과 작업자마다 자기 탭을 쓰고, 작업 공간마다 브라우저 창이 따로 있습니다. 보고 있지 않은 작업 공간의 에이전트도 뒤에서 계속 브라우저를 쓰며, 페이지가 작업 공간을 넘나들지 않습니다.
- **워크트리·터미널·파일 보기.** git 워크트리에서 작업하고, 세션별 터미널을 열고, 에이전트가 만든 이미지·PDF·마크다운을 바로 봅니다.
- **슬래시 메뉴.** `/clear`, `/compact`, `/usage`와 설치된 스킬을 이름으로 검색합니다.
- **스킬.** `~/.claude/skills`, `~/.codex/skills`, `~/.codex/prompts`, `~/.grok/skills`, 프로젝트의 `./skills`를 읽습니다. 총괄이 설치된 스킬 목록을 보고 지시서마다 맞는 스킬을 고르므로 스킬 이름을 직접 말하지 않아도 됩니다. 작업자의 CLI에 없는 스킬이면 그 지침을 붙여 줍니다.
- **봇.** 에이전트·모델·스킬·지침을 프리셋으로 저장하고, 두 봇이 정한 턴 수만큼 대화하게 합니다.
- **사용량과 업데이트.** 에이전트별 사용량을 기록하고, GitHub Releases에서 서명된 업데이트를 받습니다.

모든 것이 Mac 안에서 돌아갑니다. 시나위는 API 키를 묻거나 저장하지 않고 각 CLI의 로그인을 그대로 씁니다. 프롬프트, 선택한 스킬, 에이전트가 읽은 파일은 CLI를 직접 쓸 때와 똑같이 해당 CLI의 모델 제공사로 전송됩니다.

## 필요한 것

- macOS
- [Node.js](https://nodejs.org) **24.22.1 이상 권장** (22.x는 22.23.4 이상, 2026-10-20 보안 패치 포함). 로그인 셸의 `PATH`에 있어야 함. Apple Silicon에서는 arm64 Node를 쓴다
- 다음 CLI 중 하나 이상, 설치하고 로그인한 상태로:
  - [Codex CLI](https://github.com/openai/codex)
  - [Claude Code](https://docs.anthropic.com/ko/docs/claude-code/setup)
  - [Grok Build](https://docs.x.ai/build/overview)

시나위는 로그인 셸의 `PATH`와 흔한 설치 위치에서 CLI를 찾습니다. 앱의 도움말 화면에서 찾은 CLI와 로그인 방법을 확인할 수 있습니다.

## 설치

[최신 릴리스](https://github.com/Rakmlabs/sinawi/releases/latest)에서 `Sinawi_<버전>_universal.dmg`를 받아 열고, **Sinawi**를 **응용 프로그램** 폴더로 끌어다 놓으세요. Developer ID로 서명하고 Apple 공증을 받은 앱이라 Gatekeeper 경고 없이 열립니다. Apple Silicon과 Intel에서 모두 네이티브로 돌고, 그 뒤로는 GitHub Releases에서 스스로 업데이트합니다(재시작 시점은 직접 고릅니다).

### 소스에서 빌드

[Rust](https://rustup.rs)와 Xcode Command Line Tools(`xcode-select --install`)가 필요합니다.

```sh
git clone https://github.com/Rakmlabs/sinawi.git
cd sinawi
npm install
npm run app:build
```

앱은 `src-tauri/target/release/bundle/macos/Sinawi.app`에 만들어집니다. `/Applications`로 복사한 뒤 Finder나 Dock에서 여세요. 직접 빌드한 앱은 공증되지 않았고 서명된 업데이트도 받지 않습니다.

### 권한

에이전트가 처음 컴퓨터 조작을 쓸 때 macOS가 **개인정보 보호 및 보안 → 손쉬운 사용**과 **화면 기록** 허용을 묻습니다. 권한이 시나위 자체에 주어지도록 터미널이 아니라 Finder나 Dock에서 실행하세요.

데이터는 `~/Library/Application Support/dev.sinawi.app/`, 로그는 `~/Library/Logs/Sinawi/`에 저장됩니다.

## 개발

```sh
npm install
npm run dev        # API 127.0.0.1:3001, 웹 화면 http://127.0.0.1:5188
npm run app:dev    # 같은 구성을 Tauri 창에서
```

```sh
npm run typecheck
npm test
npm run build      # 타입 검사, Vite 빌드, 서버 번들
```

두 서버 모두 `127.0.0.1`에만 바인딩합니다. `SINAWI_PORT`와 `SINAWI_DATA_DIR`로 API 포트와 데이터 폴더를 바꿀 수 있어, 설치된 앱과 따로 한 벌 더 띄울 때 편합니다.

### 폴더 구성

| 경로 | 내용 |
|---|---|
| `server/` | Express + WebSocket 서버: CLI 실행, 오케스트레이션, 배정, 감독, 저장 |
| `src/` | React 화면 |
| `src-tauri/` | Tauri v2 셸: 창, 업데이트, 앱 내 브라우저 연결, 컴퓨터 조작 연결 |
| `scripts/` | 개발 실행, 서버 번들, 서명·릴리스 스크립트 |
| `docs/orchestration/` | 앱이 총괄과 작업자에게 강제하는 운영 규칙과 그 근거 조사 |
| `docs/RELEASING.md` | 릴리스와 서명된 자동 업데이트 방식 |
| `docs/mcp.ko.md` | 프로젝트 담당, 일정, `sinawi_lead` 도구, 앱 전체 MCP 서버 ([전체 도구 목록](docs/mcp-coverage.md)) |

## 안전

에이전트는 고른 폴더에서 파일을 고치고 명령을 실행합니다. **계획** 모드는 읽기만 하고, **자동** 모드는 프로젝트 폴더 안에서만 씁니다. **전체 권한**은 CLI 자체의 샌드박스를 끄기 때문에(예: Claude Code의 `--dangerously-skip-permissions`) 작업 공간에서 명시적으로 허용해야만 켜집니다. 시나위 자체가 샌드박스는 아니며, 에이전트가 실제로 무엇에 접근할 수 있는지는 macOS와 각 CLI에 달려 있습니다. MCP 승인 카드는 MCP 도구만 막으며, 셸을 가진 에이전트는 시나위 로컬 HTTP API를 직접 부를 수 있습니다.

## AI 에이전트용

AI 에이전트와 MCP 클라이언트는 [llms.txt](llms.txt)와 [docs/ai/for-ai.ko.md](docs/ai/for-ai.ko.md)(개념, MCP 연결, 승인 여부가 붙은 전체 도구 목록, 한계)부터 보세요. 이 저장소에서 일하는 코딩 에이전트는 [AGENTS.md](AGENTS.md)를 봅니다.

## 기여

이슈와 풀 리퀘스트를 환영합니다. 이슈를 열거나 고른 뒤 `main`에서 브랜치를 만들고, 그 이슈를 연결한 풀 리퀘스트를 보내 주세요. 개발 환경, 확인 절차, 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

## 라이선스

[MIT](LICENSE)
