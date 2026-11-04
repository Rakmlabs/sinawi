<div align="center">

<img src="docs/assets/icon.png" width="112" alt="시나위 앱 아이콘" />

# 시나위 (Sinawi)

**총괄 AI 하나, Claude Code · Codex · Grok Build 워커 팀, 그리고 채팅 하나.**

담당(총괄 AI)과 채팅만 하세요. 담당이 브리프와 스킬을 쓰고, 일을 병렬로 나눠 주고, MCP 도구로 앱 기능을 직접 씁니다. if문은 없습니다.

[![Release](https://img.shields.io/github/v/release/Rakmlabs/sinawi?style=flat-square&color=0f7b4f)](https://github.com/Rakmlabs/sinawi/releases/latest) [![Downloads](https://img.shields.io/github/downloads/Rakmlabs/sinawi/total?style=flat-square)](https://github.com/Rakmlabs/sinawi/releases) [![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square&logo=apple)](#설치) [![MCP](https://img.shields.io/badge/MCP-89%20tools-6e56cf?style=flat-square)](docs/mcp.ko.md) [![License: MIT](https://img.shields.io/github/license/Rakmlabs/sinawi?style=flat-square)](LICENSE) [![Stars](https://img.shields.io/github/stars/Rakmlabs/sinawi?style=flat-square)](https://github.com/Rakmlabs/sinawi/stargazers)

[English](README.md) · **한국어**

[다운로드](https://github.com/Rakmlabs/sinawi/releases/latest) · [동작 방식](#동작-방식) · [MCP](docs/mcp.ko.md) · [AI 에이전트용](#ai-에이전트용-문서) · [협업 문의](#만든-곳-rakm)

<br />

<img src="docs/assets/parallel-delegation.png" width="860" alt="담당이 Claude 워커 두 명에게 동시에 일을 맡기고 두 커밋을 보고하는 화면" />

<sub>담당이 Claude 워커 두 명에게 동시에 일을 맡기고, 두 worktree를 확인한 뒤 커밋을 보고했습니다.</sub>

</div>

---

## 왜 만들었나

가장 결과가 좋았던 방식은 코딩 에이전트 하나가 아니었습니다. **총괄 AI 하나가 프롬프트와 스킬을 쓰고 Claude, Codex에게 일을 나눠 주는 방식**이었습니다. 이걸 손으로 하면 터미널을 여러 개 띄우고 결과를 복사해 옮겨야 합니다.

시나위는 그 방식을 앱으로 만든 것입니다. 이미 쓰고 있는 코딩 에이전트 CLI(**Codex**, **Claude Code**, **Grok Build**)를 한 팀으로 돌리고, 모든 과정을 실시간으로 보여 줍니다.

이름은 정해진 악보 없이 즉흥으로 합을 맞추는 우리 음악 *시나위*에서 따왔습니다.

## 핵심 기능

<table>
<tr>
<td width="50%" valign="top">

### 💬 담당과 채팅만 하면 됩니다
**담당**은 프로젝트 하나를 맡는 오래가는 채팅입니다. 계속 일을 주면, 요청을 쪼개고 구조화된 브리프(목표, 맥락, 완료 기준, 제약, 검증, 보고 형식)를 쓰고 맞는 스킬을 고릅니다.

</td>
<td width="50%" valign="top">

### ⚡ 병렬 워커
`delegate_task`, `check_task`, `collect_results`. 워커가 바쁘면 담당이 워커를 더 붙이고(`claude-2` 등), 각자 자기 git worktree에서 일합니다. 디자인 작업은 스크린샷과 함께 돌아옵니다.

</td>
</tr>
<tr>
<td valign="top">

### 🧠 if문이 아니라 AI가 판단합니다
앱의 모든 기능이 MCP 도구(**89개**)로 열려 있습니다. 담당이 대화를 보고 무엇을 부를지 정합니다. 스킬 작성, 채팅·공간·담당 생성, 일정 만들기까지.

</td>
<td valign="top">

### 🛡️ 위험한 작업은 승인 카드로
삭제, 설정 변경, 병합, 터미널 명령(도구 28개)은 앱에서 승인해야 실행됩니다. AI가 자기 요청을 스스로 승인하는 도구는 없습니다. 담당별 병합 정책은 `auto`, `ask`, `never`.

</td>
</tr>
<tr>
<td valign="top">

### 🗓️ 대화하다 생기는 일정
*"매일 아침 9시에 어제 커밋 요약해줘"*라고 하면 담당이 직접 cron 일정을 만듭니다. 한 번 또는 반복, Mac 시간대 기준, 담당 설정에서 관리합니다.

</td>
<td valign="top">

### 🔌 바깥 AI도 조종할 수 있습니다
`npm run sinawi-mcp`로 Claude Desktop 같은 MCP 클라이언트가 앱 전체를 다룰 수 있습니다. 토큰은 **설정 → 일반 → 외부 AI 연결**에서 받습니다.

</td>
</tr>
</table>

<div align="center">
<img src="docs/assets/schedules.png" width="49%" alt="담당이 스스로 만든 일정이 담당 설정과 채팅 카드에 보이는 화면" />
<img src="docs/assets/approval-cards.png" width="49%" alt="AI가 요청한 담당 삭제가 승인을 기다리는 카드" />
<br />
<sub>왼쪽: 담당이 스스로 만든 일정. 오른쪽: 담당 삭제는 승인을 기다립니다.</sub>
</div>

## 동작 방식

```mermaid
flowchart LR
    U([사용자]) -- 채팅 --> L["담당<br/>Claude 또는 Codex"]
    L -- "MCP: sinawi_lead 도구" --> S[[시나위 앱]]
    S -- delegate_task --> W1["Claude 워커<br/>worktree"]
    S -- delegate_task --> W2["Codex 워커<br/>worktree"]
    S -- delegate_task --> W3["claude-2<br/>worktree"]
    W1 & W2 & W3 -- 보고 --> S
    S -- collect_results --> L
    L -. "schedule_create / write_skill / …" .-> S
    S -. "위험한 도구" .-> A{{승인 카드}}
    A -- 승인 --> S
    X([Claude Desktop 등 MCP 클라이언트]) -- "npm run sinawi-mcp" --> S
```

1. 평소처럼 담당과 채팅합니다.
2. 앱이 MCP로 담당에게 도구를 줍니다. 무엇을 쓸지는 담당이 정합니다.
3. 워커는 각자 worktree에서 병렬로 일하고, 시나위가 보고를 확인해 결과를 돌려줍니다.
4. 되돌릴 수 없는 작업은 승인 카드에서 멈추고 결정을 기다립니다.

> [!NOTE]
> MCP 도구는 Claude, Codex 담당이 씁니다. **Grok 담당**은 실행마다 MCP를 붙이는 방법이 아직 없어서 텍스트 태그 방식으로 동작하고, 이 도구들은 쓸 수 없습니다.

## 설치

**[최신 릴리즈](https://github.com/Rakmlabs/sinawi/releases/latest)**에서 `Sinawi_<버전>_universal.dmg`를 받아 열고 **Sinawi**를 **응용 프로그램**으로 끌어다 놓으세요.

- Developer ID로 서명되고 Apple 공증을 받아 Gatekeeper 경고 없이 열립니다.
- Apple Silicon과 Intel 모두 네이티브로 동작합니다.
- 이후에는 GitHub Releases에서 자동 업데이트됩니다(재시작 시점은 직접 고릅니다).

### 요구 사항

- macOS
- [Node.js](https://nodejs.org) **24.22.1 이상 권장**(22.x는 2026-10-20 보안 릴리즈인 22.23.4 이상), 로그인 셸 `PATH`에 있어야 합니다. Apple Silicon에서는 arm64 Node를 쓰세요
- 다음 CLI 중 하나 이상 설치 및 로그인: [Codex CLI](https://github.com/openai/codex) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) · [Grok Build](https://docs.x.ai/build/overview)

시나위는 로그인 셸의 `PATH`와 흔한 설치 위치에서 CLI를 찾습니다. 앱의 도움말 패널에서 찾은 CLI와 로그인 방법을 볼 수 있습니다. API 키는 묻지도 저장하지도 않고, 각 CLI의 로그인을 그대로 씁니다.

## 바깥 AI 연결 (MCP)

```sh
npm run sinawi-mcp
```

**설정 → 일반 → 외부 AI 연결 (MCP)**에서 연결 설정을 복사해 MCP 클라이언트에 넣으세요. 조회와 생성은 바로 실행되고, 위험한 도구는 승인 카드를 기다립니다. 자세한 안내: [docs/mcp.ko.md](docs/mcp.ko.md) · 도구 범위: [docs/mcp-coverage.md](docs/mcp-coverage.md)

<details>
<summary><b>그 밖의 기능</b></summary>

- **담당과 워커.** 담당과 워커 조합을 직접 고르거나, *자동* 라우팅이 요청에 맞는 팀, 모델, 스킬을 고르게 할 수 있습니다. 브리프의 빠진 부분을 채우고, 요약 과정에서 사용자의 원래 말이 빠지지 않게 덧붙입니다. 한 워커의 브리프는 차례로, 여러 워커는 동시에 실행됩니다.
- **권한 모드**(Claude Code와 같은 방식): *계획*(읽기 전용, 담당이 제안한 계획을 한 번에 실행), *자동*(프로젝트 폴더 안에서 수정하고 일반 명령은 묻지 않음, Claude Code는 CLI 자체 auto 모드 사용), *전체 권한*(공간이 허용할 때만).
- **실시간 보기.** 메시지, 도구 호출, 명령, 파일 변경이 생기는 대로 보이고, CI나 배포를 기다리는 중인지도 표시됩니다.
- **공간.** 대화, 프로젝트, 기본값을 나눠 둡니다(F1 / F2). 공간마다 실행할 수 있는 에이전트, 컴퓨터 제어·전체 권한 허용 여부, 막을 MCP 도구를 정합니다.
- **사용량 대체.** CLI 하나의 사용량이 바닥나기 직전이면 다음으로 정해 둔 에이전트로 역할을 넘길 수 있습니다.
- **내장 브라우저와 컴퓨터 제어.** 에이전트가 앱의 브라우저를, macOS 권한을 주면 다른 앱도 조작합니다. 세션과 워커마다 탭이 따로 있고, 페이지는 공간을 넘나들지 않습니다.
- **Worktree, 터미널, 파일.** git worktree, 세션별 터미널, 이미지·PDF·Markdown 미리보기.
- **입력창.** `1. `, `- `, Shift+Enter로 마크다운 리스트가 이어지고, 한글 조합 입력도 처리합니다.
- **슬래시 메뉴.** `/clear`, `/compact`, `/usage`와 설치된 모든 스킬.
- **스킬.** `~/.claude/skills`, `~/.codex/skills`, `~/.codex/prompts`, `~/.grok/skills`, 프로젝트의 `./skills`를 읽습니다. 스킬이 없는 CLI의 워커에게는 지침을 첨부합니다.
- **봇.** 에이전트, 모델, 스킬, 지침을 프리셋으로 저장하고, 봇 둘이 정한 횟수만큼 대화하게 할 수 있습니다.
- **사용량과 업데이트.** 에이전트별 사용량 추적과 서명된 자동 업데이트.

</details>

<details>
<summary><b>소스에서 빌드</b></summary>

[Rust](https://rustup.rs)와 Xcode Command Line Tools(`xcode-select --install`)가 필요합니다.

```sh
git clone https://github.com/Rakmlabs/sinawi.git
cd sinawi
npm install
npm run app:build
```

앱은 `src-tauri/target/release/bundle/macos/Sinawi.app`에 만들어집니다. 직접 빌드한 앱은 공증되지 않고 서명된 업데이트도 받지 않습니다.

개발:

```sh
npm run dev        # API 127.0.0.1:3001, 웹 UI http://127.0.0.1:5188
npm run app:dev    # Tauri 창에서 같은 환경
npm run typecheck && npm test && npm run build
```

두 서버 모두 `127.0.0.1`에만 열립니다. `SINAWI_PORT`, `SINAWI_DATA_DIR`로 API 포트와 데이터 폴더를 바꿀 수 있습니다.

| 경로 | 내용 |
|---|---|
| `server/` | Express + WebSocket 서버: CLI 실행, 오케스트레이션, 라우팅, 감독, 저장, MCP |
| `src/` | React UI |
| `src-tauri/` | Tauri v2 셸: 창, 업데이터, 내장 브라우저 브리지, 컴퓨터 제어 브리지 |
| `scripts/` | 개발 실행, 서버 번들러, 서명·릴리즈 스크립트 |
| `docs/orchestration/` | 앱이 담당과 워커에게 적용하는 운영 규칙 |
| `docs/RELEASING.md` | 릴리즈와 서명된 자동 업데이트 방식 |
| `docs/mcp.ko.md` | 담당, 일정, `sinawi_lead` 도구, 앱 전체 MCP 서버 |

</details>

<details>
<summary><b>권한과 데이터</b></summary>

에이전트가 처음 컴퓨터 제어를 쓰면 macOS가 **개인정보 보호 및 보안 → 손쉬운 사용**과 **화면 기록**에서 시나위를 허용하라고 묻습니다. macOS가 시나위 자체에 권한을 주도록, 터미널이 아니라 Finder나 Dock에서 여세요.

데이터는 `~/Library/Application Support/dev.sinawi.app/`, 로그는 `~/Library/Logs/Sinawi/`에 있습니다.

</details>

## FAQ

**API 키가 필요한가요?**
아니요. 각 CLI의 로그인을 씁니다. 프롬프트, 고른 스킬, 에이전트가 읽은 파일은 CLI를 직접 실행할 때처럼 그 CLI의 모델 제공사로 전송됩니다.

**샌드박스인가요?**
아니요. *계획*은 읽기 전용, *자동*은 프로젝트 폴더 안에서만 쓰고, *전체 권한*은 CLI 자체 샌드박스를 끄기 때문에 공간이 허용할 때만 켜집니다. 승인 카드는 MCP 도구만 막습니다. 셸을 가진 에이전트는 시나위의 로컬 HTTP API를 직접 부를 수 있습니다.

**Grok Build를 담당으로 쓸 수 있나요?**
네, 다만 지금은 MCP 도구 없이 동작합니다(위 안내 참고). 전체 도구는 Claude, Codex 담당이 씁니다.

**Windows나 Linux는요?**
지금은 macOS만 지원합니다.

## 로드맵

- [ ] Grok 담당용 MCP 도구
- [ ] Codex 담당의 MCP 도구 사용 전체 검증
- [ ] 정확한 분 단위 일정 실행(지금은 최대 1분 늦을 수 있음)

## AI 에이전트용 문서

AI 에이전트와 MCP 클라이언트는 [llms.txt](llms.txt)와 [docs/ai/for-ai.ko.md](docs/ai/for-ai.ko.md)(개념, MCP 설정, 승인 여부를 포함한 전체 도구, 제한)부터 보세요. 이 저장소에서 일하는 코딩 에이전트는 [AGENTS.md](AGENTS.md)를 보세요.

## 기여하기

이슈와 풀 리퀘스트를 환영합니다. 이슈를 열거나 고르고, `main`에서 브랜치를 만든 뒤 이슈를 연결한 풀 리퀘스트를 보내 주세요. 설정, 검사, 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

## 만든 곳: rakm

<table>
<tr>
<td>

시나위는 **[rakm](https://github.com/Rakmlabs)**의 **최원락 (Won Rak Choi)**이 만들고 관리합니다.

rakm은 AI 네이티브 제품과 개발 도구를 만들고, 외주와 협업도 맡습니다. AI 에이전트 워크플로, MCP 연동, 데스크톱 앱(Tauri), 웹 프론트엔드.

**협업 문의:** [1rrock@rakm.co.kr](mailto:1rrock@rakm.co.kr) · [GitHub @Rakmlabs](https://github.com/Rakmlabs) · LinkedIn: <!-- TODO: LinkedIn 프로필 URL 추가 --> _준비 중_

</td>
</tr>
</table>

시나위가 도움이 됐다면 ⭐ 하나가 다른 사람이 찾는 데 큰 도움이 됩니다.

## Star History

<a href="https://star-history.com/#Rakmlabs/sinawi&Date">
  <img src="https://api.star-history.com/svg?repos=Rakmlabs/sinawi&type=Date" alt="Star history 차트" width="600" />
</a>

## 라이선스

[MIT](LICENSE) © 2026 Rakmlabs
