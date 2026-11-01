# 공개 코딩 에이전트 프롬프트·오케스트레이션 연구 (2026-10-31)

범위는 `/tmp/ao-study`에 있는 공개 clone이다. 라이선스가 공개된 소스만 읽었다. 유출본, 역공학, 배포 바이너리는 쓰지 않았다. 네트워크로 문서를 다시 받지 않았다.

로컬 clone: [openai/codex](https://github.com/openai/codex) (Apache-2.0), [anthropics/claude-code](https://github.com/anthropics/claude-code), [sst/opencode](https://github.com/sst/opencode) (MIT), [cline/cline](https://github.com/cline/cline) (Apache-2.0), [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) (Apache-2.0), [Aider-AI/aider](https://github.com/Aider-AI/aider) (Apache-2.0).

이번 clone에 없는 것: OpenHands, Roo Code, `claude-plugins-official`의 feature-dev/code-review 플러그인 본문. 그 저장소를 읽은 것처럼 적지 않는다. Claude 쪽은 이 저장소의 플러그인 README와 예제만 확인했다.

적용 위치: `server/supervision.ts`의 `ORCHESTRATOR_RULES`, `WORKER_RULES`, `cliNotes`, `ensureBrief`, `reviewPrompt`. 조립은 `server/orchestra.ts`. 6필드 브리프, 정체 감지, 재위임 상한 2회는 유지했다.

## 1. 로컬 소스에서 확인한 기법

| 도구 | 로컬 출처 | 확인한 기법 |
|---|---|---|
| Codex CLI | [`gpt_5_2_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md), [`templates/agents/orchestrator.md`](https://github.com/openai/codex/blob/main/codex-rs/core/templates/agents/orchestrator.md), [`templates/collab/experimental_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/templates/collab/experimental_prompt.md) | AGENTS.md는 그 폴더 트리 전체에 적용되고, 더 깊은 파일이 우선한다. 사용자·개발자 지시가 AGENTS.md보다 우선한다. `update_plan`은 여러 단계·모호한 작업에만 쓰고, 한 단계 계획과 쉬운 작업(대략 상위 40%가 아닌 쪽, orchestrator 템플릿은 "가장 쉬운 40%")에는 쓰지 않는다. 진행 중 단계는 하나. `apply_patch`는 한 파일 편집에 쓰고, 포매터·생성물·광범위 치환은 명령으로 한다. 성공한 패치 파일을 다시 읽지 않는다. 자신이 만들지 않은 변경이 보이면 멈추고 묻는다. `git reset --hard`, `git checkout --` 금지. 최종 답은 결과부터, 불릿은 보통 4~6개, 경로·명령은 백틱. 서브에이전트를 쓰면 총괄은 조정만 하고 끝날 때까지 기다린다. 병렬은 독립 단계만. 서브에이전트에게 "혼자 있지 않다, 남의 작업을 되돌리지 마라"와 "하위 에이전트를 만들 수 있는지"를 말한다. 로그가 큰 테스트는 서브에이전트에 맡겨 총괄 컨텍스트를 아낀다. 승인은 never / untrusted / on-request로 나뉘고, 테스트 실행 여부를 모드에 따라 가른다. |
| Gemini CLI | [`packages/core/src/prompts/snippets.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts) | Research → Strategy → Execution, 실행은 Plan → Act → Validate. "Validation is the only path to finality." 같은 수정을 3번 넘게 실패하면 원래 과제를 다시 읽고, 가정을 나열하고, 다른 구조를 제안한다. 라이브러리가 있다고 가정하지 말고 package.json 등으로 확인한다. GEMINI.md는 하위 디렉터리가 루트보다 우선하고, 안전 규칙까지 덮지는 못한다. 같은 파일을 한 턴에 여러 번 고치지 않는다. 이전 도구 결과에 의존하면 순서를 지킨다. 독립 읽기는 병렬. 서브에이전트는 같은 파일을 동시에 고치지 않는다. 출력이 큰 작업은 위임한다. 텍스트는 실무적으로 3줄 안을 목표로 한다. Plan 모드는 읽기 전용이고, 승인 뒤에야 실행 모드로 바뀐다. 할 일 도구는 한 단계가 아닌 작업에 쓴다. |
| OpenCode | [`system-prompt/gpt.txt`](https://github.com/sst/opencode/blob/main/packages/core/src/plugin/system-prompt/gpt.txt), [`kimi.txt`](https://github.com/sst/opencode/blob/main/packages/core/src/plugin/system-prompt/kimi.txt), [`anthropic.txt`](https://github.com/sst/opencode/blob/main/packages/core/src/plugin/system-prompt/anthropic.txt), [`plugin/plan.ts`](https://github.com/sst/opencode/blob/main/packages/core/src/plugin/plan.ts), [`session/runner/prompt/system.txt`](https://github.com/sst/opencode/blob/main/packages/core/src/session/runner/prompt/system.txt) | 모델마다 시스템 문구가 다르다. 공통은 짧다. 최종 답은 결과부터. 익숙하지 않은 변경은 사용자 작업으로 보고 지우기 전에 조사한다. 파괴적 git 금지. 서브에이전트는 사용자가 시키거나 AGENTS.md가 시킬 때만. Plan 모드는 편집 권한이 막혀 있고, "구현하라"고 해도 구현하지 말라고 상기시킨다. kimi 문구는 고치기 전에 read/grep으로 읽고, 테스트가 있으면 돌리고, 실패하면 오류를 읽고 다시 고친다. 변경은 최소. git commit/push/reset/rebase는 명시 요청 전엔 하지 않는다. |
| Cline | [`apps/vscode/src/core/prompts/responses.ts`](https://github.com/cline/cline/blob/main/apps/vscode/src/core/prompts/responses.ts) | 완료는 `attempt_completion`으로 끝낸다. 도구를 안 쓰면 다시 도구를 쓰라고 한다. `write_to_file`이 3번 연속 실패하면 같은 쓰기를 멈추고 더 작은 편집으로 바꾼다. 편집 블록이 비면 먼저 `read_file` 하라. 밖에서 바뀐 파일은 고치기 전에 다시 읽는다. 성공한 편집 직후 재읽기는 하지 않는다. AGENTS.md는 그 디렉터리의 읽기·쓰기에만 적용한다. 컨텍스트를 자를 때도 처음 사용자 과제는 남긴다. |
| Aider | [`aider/coders/base_prompts.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_prompts.py) | `lazy_prompt`: 주석만 남기지 말고 완전히 구현. `overeager_prompt`: 요청 범위만, 관련 없는 수정 금지. 채팅에 넣은 파일 내용을 진실로 보고, 그 이전 메시지의 파일 내용은 오래된 것으로 본다. repo map에만 있는 파일은 읽기 전용이고, 고치려면 채팅에 추가하라고 한다. |
| Claude Code 공개 저장소 | [`plugins/README.md`](https://github.com/anthropics/claude-code/blob/main/plugins/README.md) | 플러그인 본문은 [claude-plugins-official](https://github.com/anthropics/claude-plugins-official)에 있고 이 clone에는 없다. README가 가리키는 공식 문서: [plugins](https://docs.claude.com/en/docs/claude-code/plugins), [overview](https://docs.claude.com/en/docs/claude-code/overview), [Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). 서브에이전트·CLAUDE.md·hooks의 본문은 이번 패스에서 다시 받지 않았다. |

## 2. 공통 패턴

여덟 가지가 소스에서 반복된다.

1. **계획/TODO.** 여러 단계일 때만 계획을 만든다. 한 단계 계획과 쉬운 작업에는 쓰지 않는다. 진행 중 항목은 하나고, 끝날 때마다 갱신한다. (Codex `update_plan`, Gemini task tracker / Plan 모드, OpenCode Plan 에이전트)
2. **한 번에 한 단계.** 다음 행동이 이전 도구 결과에 의존하면 결과를 본 뒤에 진행한다. 독립적인 읽기는 병렬로 한다. 같은 파일은 한 번에 한 워커. (Gemini, Codex 오케스트레이터, Cline의 "도구 결과 다음 행동")
3. **편집 전 읽기.** 파일 내용을 추측해서 고치지 않는다. 밖에서 바뀌었으면 다시 읽는다. 패치가 성공한 직후의 재읽기는 생략한다. (Cline, Gemini edit 실패 설명, OpenCode kimi, Codex apply_patch)
4. **검증.** 테스트·빌드·타입 확인이 완료의 조건이다. 증거 없는 완료는 완료가 아니다. 관련 없는 실패는 고치지 않는다. (Gemini "Validation is the only path to finality", Codex "Validating your work")
5. **완료 기준.** 확인 가능한 문장으로 미리 정한다. 보고는 결과, 증거, 남은 문제 순이고 짧다. 끝에 질문이나 추가 제안을 붙이지 않는 쪽이 완료 신호와 맞다. (Cline `attempt_completion`, Codex 최종 답 분량)
6. **서브에이전트 브리프.** 새 에이전트는 이 대화를 보지 못한다. 경로, 확인된 값, 실패 이유, 다른 에이전트와 같은 작업 트리라는 사실, 하위 에이전트를 만들면 안 되는지를 적는다. 로그가 큰 일은 맡기고 요약만 받는다. (Codex collab, Gemini sub-agents, OpenCode kimi의 "complete prompt")
7. **실패 시 중단.** 같은 실패가 3번이면 같은 방법을 멈추고, 원래 과제와 가정을 다시 보고, 다른 접근을 낸다. (Gemini Strategic Re-evaluation, Cline 3연속 write 실패)
8. **컨텍스트 파일.** AGENTS.md / CLAUDE.md / GEMINI.md는 그 폴더 아래에만 적용되고, 더 깊은 파일이 우선한다. 사용자와 이번 과제의 직접 지시가 그 파일보다 우선한다. (Codex AGENTS.md spec, Gemini context precedence, Cline agentsRules, OpenCode kimi)

품질의 나머지는 프롬프트 밖에 있다. Codex의 `apply_patch`와 승인 모드, Gemini의 Plan 모드 권한 거부, OpenCode의 편집 deny, Cline의 완료 도구가 그 예다. 지침만으로 그 도구를 대체하지는 못한다. Agent Orchestra에서는 6필드 자동 보완, 정체 감지, 재위임 상한이 이미 그 역할의 일부다.

## 3. 적용 전 Agent Orchestra와 빈칸

당시 코드(`server/supervision.ts`, `server/orchestra.ts`)와 [OPERATING-RULES.md](./OPERATING-RULES.md):

| 항목 | 적용 전 | 공개 도구에서 가져온 빈칸 |
|---|---|---|
| 위임 형식 | 6제목 강제와 자동 채움 | 다른 워커와 공존, 지침 파일 스코프가 기본 제약에 없었음 |
| 총괄 역할 | 위임 후 검증. Grok이 실패하면 사후에 직접 작업을 막음 | "워커가 일하는 동안 총괄은 조정만"이 공통 규칙이 아니었음 |
| 계획 | 플래너가 있으면 위험·완료 조건 | 2단계 미만이면 계획을 쓰지 말 것, 확인 가능한 단계, 같은 파일 병렬 금지가 약했음 |
| 검증 | 총괄이 증거를 대조하고 재위임 | 가정 나열, 믿을 발견의 범위(테스트 실패·로직·제약·범위), 읽기 전용 제한이 약했음 |
| 작업자 | 3회 오류, snapshot, 부분 완료 | 편집 전 읽기, 의존 단계는 결과 확인 후, TODO 금지, 라이브러리 확인, 남의 변경 유지, 지침 파일 |
| 모델별 문구 | 공통 1벌 | OpenCode처럼 CLI 보정이 없었음 |
| 완료 신호 | 상태/한 일/증거/남은 문제 | 유지. 별도 완료 도구는 앱에 없으므로 이 형식을 유지함 |
| 독립 검증 프로세스 | 없음 | 별도 CLI를 추가하면 기존 호출 횟수와 재위임 루프가 바뀜 |

## 4. 코드에 넣은 것

호출 구조는 그대로다. 검증 체크리스트는 새 프로세스가 아니라 기존 `reviewPrompt`에 들어간다. 정체 감지(`StallDetector`)와 `maxReplanRounds = 2`, Grok이 실패 후 재위임 없이 끝내려 할 때의 1회 재요청도 그대로다.

- 총괄: 계획·위임·검증·보고. 워커가 일하는 동안 같은 일을 직접 하지 않음. 2단계 이상만 계획. 핵심 파일 탐색 위임. 큰 로그는 요약만. 지침 파일을 브리프 제약으로 옮김. 예상 밖 변경은 멈추고 보고하고 되돌리지 않음.
- 워커: 편집 전 읽기, 의존 단계는 결과 확인 후, 3회 실패 시 가정과 함께 막힘, 완전 구현, 범위 유지, 라이브러리 확인, 남의 변경 유지, 가까운 지침 파일, 검증 증거, 보고 끝에 질문 없음. 6제목과 ao-browser snapshot 규칙 유지.
- 자동 보완 제약: 다른 작업자의 변경 금지와 AGENTS.md / CLAUDE.md / GEMINI.md.
- 검증 프롬프트: 읽기 전용. 기준을 하나씩 대조. 증거 재확인. 스타일·추측·기존 문제는 제외. 실패 시 목표 재진술, 가정 나열, 다른 접근으로 6제목 재위임.
- `cliNotes`: CLI마다 총괄·작업자 보정을 붙인다. 한도 전환으로 실행 CLI가 바뀌면 `retargetCliNotes`가 이전 문구를 새 CLI 문구로 바꾼다. 내용의 근거는 아래 6절.
- 플래너가 켜져 있으면 읽기 전용, 확인 가능한 단계, 가정, 완료 조건만 쓴다.

대응 문구는 [prompts/](./prompts/)에 코드와 맞춰 두었다.

## 5. 아직 프롬프트 밖에 있는 것

- 역할마다 도구 허용 목록을 나누는 일 (Gemini Plan의 edit deny, Claude 서브에이전트의 tools 목록). 지금은 문구로 "읽기 전용" "구현하지 마라"만 말한다.
- 구조화 편집 도구. Codex `apply_patch`에 해당하는 형식은 각 CLI 안에 있고, Orchestra는 그 CLI를 호출한다.
- 긴 세션 압축 템플릿. Cline은 자를 때 처음 과제를 남긴다. Orchestra의 핸드오프 요약은 별도 경로다.
- 신뢰도 숫자(80 이상만 보고)는 이 clone에서 재확인하지 못했다. 검증 프롬프트는 "근거가 있을 때만"으로 줄였다.

## 6. CLI별 깊은 보정

1차 `cliNotes`는 한두 줄이었다. 2차는 각 하네스가 실제로 강제하는 도구와 실패 방식만 보강했다. 공통 6필드, `StallDetector`, `maxReplanRounds = 2`는 그대로다.

| CLI | 로컬에서 확인한 것 | 지침에 넣은 차이 |
|---|---|---|
| Codex | [`gpt_5_2_prompt.md`](file:///tmp/ao-study/codex/codex-rs/core/gpt_5_2_prompt.md)의 Planning, apply_patch, Validating, Final answer. [`orchestrator.md`](file:///tmp/ao-study/codex/codex-rs/core/templates/agents/orchestrator.md)의 쉬운 40%와 한 단계 계획 금지. [`experimental_prompt.md`](file:///tmp/ao-study/codex/codex-rs/core/templates/collab/experimental_prompt.md)의 "혼자 있지 않다, 하위 에이전트 금지". [`agents_md_tests.rs`](file:///tmp/ao-study/codex/codex-rs/core/src/agents_md_tests.rs)의 `AGENTS.override.md`가 같은 폴더의 AGENTS.md를 대신함 | `update_plan`은 여러 단계만, `in_progress`는 하나, 계획 전문을 반복하지 않음. 한 파일은 `apply_patch`(JSON 아님). 성공한 패치는 다시 읽지 않음. 루트~작업 폴더 AGENTS.md는 재독 금지. 검증은 가까운 테스트부터, 포매터 3회. 비대화형이므로 승인 대기 없이 브리프 검증. 최종 답은 결과부터, 작은 변경 3불릿, 보통 6불릿, `path:line` 하나 |
| Claude Code | 시스템 프롬프트 본문은 이 clone에 없다. [`CHANGELOG.md`](file:///tmp/ao-study/claude-code/CHANGELOG.md): 중첩 CLAUDE.md는 Read에 붙고 `cat`/`head`/`tail`/`sed -n`/`grep`에는 빠졌던 적이 있음. CLAUDE.md가 없으면 AGENTS.md. TodoWrite와 TaskCreate/Get/Update/List는 Opus 4.8, Sonnet 5 이후 기본 꺼짐(`CLAUDE_CODE_ENABLE_TODO_TOOLS`). `claude -p`의 포크 서브에이전트는 기본 켜짐. `/code-review` 발견은 번호 목록이고, CLAUDE.md를 고친 diff는 베이스 규칙으로 봄. 목록을 어떻게 갱신하는지는 OpenCode [`todowrite.txt`](file:///tmp/ao-study/opencode/packages/core/src/tool/todowrite.txt): 3단계 이상, 매번 전체 목록, 시작 시 `in_progress`, 끝나면 `completed` | Read로 지침 파일을 붙임. 도구가 있을 때만 TodoWrite. 서브에이전트를 만들지 않음. 리뷰는 근거 있는 번호 목록, 없으면 발견 없음. 증거 없는 완료는 부분 완료 |
| Grok | 공개 프롬프트가 아님. 이 저장소 [`server/cli.ts`](../../server/cli.ts)의 `grokHeadlessRules`와 `DEVELOPMENT_SHELL_PROGRAMS`. `--permission-mode auto`와 `--allow Bash(<program>:*)`. 목록 밖 명령은 헤드리스에서 실행 전체를 취소 | 허용된 프로그램으로 시작하는 명령 하나. `cd`, `&&`, `||`, `;`, 대입, `$(...)`, 반복, `bash -c` 금지. 거부되면 변형 재시도 없이 즉시 막힘. 총괄은 그 이유로 재위임. 보고 네 줄 |

선택도 같이 고쳤다. 총괄 프롬프트는 `session.agent`, 워커 프롬프트는 `worker.agent`의 `cliNotes`를 쓴다. 한도가 소진돼 다른 CLI로 다시 돌릴 때는 프롬프트 안에 남은 이전 문구를 `retargetCliNotes`가 갈아 끼운다. 문구가 없는 플래너 프롬프트는 그대로 둔다.

Grok 허용 목록은 프롬프트와 `buildInvocation`이 같은 `DEVELOPMENT_SHELL_PROGRAMS`를 본다.

