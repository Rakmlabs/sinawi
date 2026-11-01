# CLI별 보정

코드: `cliNotes(agent, role)`. 공통 규칙 뒤에 붙입니다. 한도 전환으로 실행 CLI가 바뀌면 `retargetCliNotes`가 이전 CLI 문구를 새 CLI 문구로 바꿉니다. 플래너 프롬프트에는 붙이지 않습니다.

문구는 그 CLI의 도구와 제약에 대한 보정입니다. 6필드 브리프, 정체 감지, 재위임은 공통 규칙에 그대로 있습니다.

## Codex

로컬 근거: `gpt_5_2_prompt.md`의 `update_plan`, `apply_patch`, 최종 답 분량, `templates/agents/orchestrator.md`, `templates/collab/experimental_prompt.md`, `agents_md.rs`의 `AGENTS.override.md` 우선.

- 총괄: `update_plan`은 여러 단계·모호한 작업만. 쉬운 약 40%와 한 단계 계획은 없음. `in_progress`는 하나, `pending`에서 `completed`로 건너뛰지 않음. 계획 전문을 다시 옮기지 않음. 워커 제약에 AGENTS.md 범위. 루트부터 작업 폴더까지는 이미 주입됨. 독립 단계만 병렬, 끝날 때까지 대기. 최종 답은 결과부터, 작은 변경은 3불릿 안, 보통은 6불릿 안. 경로는 `path:line` 하나.
- 작업자: 한 파일은 `apply_patch`(JSON 아님, `applypatch` 아님). 포매터·생성물·여러 파일의 같은 치환은 명령. 성공한 패치는 다시 읽지 않음. 검증은 가까운 테스트부터, 포매터는 3번. 비대화형이므로 승인을 기다리지 않고 브리프 검증을 실행. 검색은 `rg`. 파괴적 git과 요청 없는 commit 금지.
- 회사 공간에서는 사용 금지(기존 정책).

## Claude

로컬 근거: 이 clone에는 Claude Code 시스템 프롬프트 본문이 없다. `CHANGELOG.md`와 `mods/`가 확인하는 동작, 그리고 OpenCode `todowrite.txt`의 목록 규칙을 썼다.

- 총괄: 범위 밖 위임 금지. `claude -p`는 Agent 도구와 포크 서브에이전트가 기본으로 켜져 있으므로 워커에게 금지. CLAUDE.md와 `.claude/rules`를 제약으로. CLAUDE.md가 없으면 AGENTS.md. 파일이 길면 앞부분만 보였을 수 있음. 리뷰는 버그·회귀·빠진 테스트의 번호 목록, 근거(파일, 줄, 이유). 없으면 발견 없음. 파일은 Read.
- 작업자: Read로 중첩 CLAUDE.md를 붙임. `cat`/`head`/`tail`/`sed -n`/`grep`으로는 빠질 수 있음. TodoWrite와 TaskCreate/Update/List/Get은 세션이 제공할 때만, 3단계 이상. 호출마다 목록 전체, 바뀔 때만 다시 호출. 시작은 `in_progress`, 끝나면 `completed`. 최신 모델은 `CLAUDE_CODE_ENABLE_TODO_TOOLS`가 없으면 이 도구가 꺼져 있음. 서브에이전트를 만들지 않음. 증거 없는 완료는 부분 완료.
- bbanana에서는 사용 금지(기존 정책).

## Grok

관찰은 이 앱의 `cli.ts`다. `grokHeadlessRules`와 `DEVELOPMENT_SHELL_PROGRAMS`. 공개 Grok 시스템 프롬프트에서 가져온 문장이 아니다. 허용 목록은 `--allow`와 같은 상수다.

- 총괄: 실패나 권한 거부면 직접 고치지 않고 재위임. 읽기 전용만. 검증 명령도 허용된 프로그램 하나. 체인과 `bash -c` 금지. 거부 이유는 짧게 보고 바로 재위임. 도구 결과를 두 번 말하지 않음.
- 작업자: 헤드리스라 승인 창이 없고, 목록 밖 명령은 실행 전체를 취소. 프로그램 하나로 시작하는 명령 하나. `cd`, `&&`, `||`, `;`, 변수 대입, `$(...)`, 반복문, `bash -c` 금지. 긴 로직은 `.py` 다음 `python3` 한 번. 거부되면 변형 재시도 없이 즉시 막힘. 보고 네 줄을 빠짐없이.

## 공통

색상 경고 제거(`cliChildEnv`)와 정체 감지의 중복 출력 무시는 이미 코드에 있다.
