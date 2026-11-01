# 오케스트레이션 품질 리서치 (2026-10-31)

목표: Agent Orchestra의 총괄→작업자 위임 품질을 "사람이 좋은 지시문을 써서 Claude/Codex에 맡길 때" 수준으로 올린다.
공개 문서·공개 저장소만 사용했다. 비공개 앱은 분석하지 않았다.

## 1. 출처
| 출처 | 링크 | 가져온 패턴 |
|---|---|---|
| Anthropic, Building effective agents | https://www.anthropic.com/research/building-effective-agents | orchestrator-workers, evaluator-optimizer 루프, 멈춤 조건(최대 반복), 도구 설명(ACI)을 프롬프트만큼 신경 쓸 것 |
| Anthropic, How we built our multi-agent research system | https://www.anthropic.com/engineering/multi-agent-research-system | 위임 지시에 **목표·출력 형식·도구 안내·작업 경계**를 명시하지 않으면 작업자가 중복·누락·헤맴. 작업 규모 가이드, 결과 검증 |
| Claude Code subagents | https://code.claude.com/docs/en/sub-agents | 작업자는 자기 컨텍스트에서 일하고 **요약만** 돌려준다. 최소 권한 도구. 중간 승인 필요한 일은 위임하지 말 것 |
| Claude Code 병렬 에이전트 / workflows | https://code.claude.com/docs/en/agents , https://code.claude.com/docs/en/workflows | 같은 파일은 동시에 맡기지 말 것(worktree), 루프·분기를 코드(스크립트)가 쥐고 결과를 교차 검증 |
| Claude Academy, Using subagents effectively | https://academy.claude.com/courses/introduction-to-subagents/using-subagents-effectively | 단계가 서로 의존하면 쪼개지 말 것(핸드오프에서 정보 손실) |
| OpenAI, A practical guide to building agents | https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf | manager 패턴, 가드레일, **실패 임계치 초과 시 사람/상위에 넘기기**, 고위험 작업 승인 |
| OpenAI Codex manual / AGENTS.md | https://learn.chatgpt.com/docs/codex-manual , https://github.com/openai/codex | Plan mode, AGENTS.md에 "완료의 정의와 검증 방법", update_plan 단계 관리 |
| Codex approvals & sandbox | https://learn.chatgpt.com/docs/agent-approvals-security | read-only / workspace-write / on-request 승인, Auto-review, 위험 우회 플래그 비권장 |
| Codex in-app browser | https://developers.openai.com/codex/app/browser | 요소/영역에 코멘트를 달아 정밀 지시, 브라우저 작업은 작게, 끝나면 다시 확인 |
| Grok Build | https://x.ai/build , https://docs.x.ai/build/cli/headless-scripting | plan mode, 서브에이전트, AGENTS.md·skills·hooks, headless `-p --output-format streaming-json`, `--no-auto-update`, always-approve 지양 |
| OpenHands StuckDetector | https://github.com/All-Hands-AI/OpenHands (openhands/controller/stuck.py) | 같은 action/observation 반복, 같은 오류 반복, 독백 반복을 감지해 루프 차단 |
| Aider | https://aider.chat/docs/usage/lint-test.html | 편집 후 자동 lint/test → 실패를 다시 먹여 수정(검증을 루프에 내장) |
| Cline / Roo Code Boomerang(Orchestrator) | https://docs.roocode.com/features/boomerang-tasks | `new_task`로 하위 작업 위임, 하위는 `attempt_completion` **요약**으로만 복귀, 모드별 권한 |
| LangGraph supervisor | https://langchain-ai.github.io/langgraph/tutorials/multi_agent/agent_supervisor/ | 감독자가 매 턴 다음 작업자 또는 종료를 결정, recursion_limit |
| CrewAI hierarchical | https://docs.crewai.com/concepts/processes | manager가 결과 검증 후 재할당, `max_iter`·`max_execution_time` |
| Playwright MCP | https://github.com/microsoft/playwright-mcp | 접근성 **snapshot을 먼저** 받고 그 ref로 조작(선택자 추측 금지) |
| Orca (stablyai) | https://github.com/stablyai/orca | 작업자별 git worktree 격리, 한 화면에서 여러 CLI 추적 |
| Orkas | https://github.com/Orkas-AI | Commander가 목표→할 일 목록으로 바꿔 전문 에이전트에 배정 |
| Alchemist Coder | https://coder.alekla.com/ | 에이전트·서브에이전트 트리 실시간 표시, 브라우저 구동 관찰 |
| awesome-coding-agents (agent-watch 등) | https://github.com/kailiu42/awesome-coding-agents | 정체(stalled) 작업 감시, 승인 게이트, QA 증거 수집 도구 군 |

enowX, wmux는 공개 자료를 찾지 못했다(검색 결과 없음). 비슷한 swe-mux/agent-watch류 패턴으로 대체했다.

## 2. 핵심 패턴 (우선순위순)
1. **위임 브리프 템플릿** — 목표 / 맥락 / 완료 기준 / 제약 / 검증 / 보고 형식. Anthropic 리서치 시스템이 "짧은 위임 지시가 작업자 헤맴의 1순위 원인"이라고 명시. 작업자는 총괄 대화를 못 본다.
2. **요약 + 증거로 복귀** — Claude subagents, Roo `attempt_completion`. "완료" 한 단어가 아니라 상태·한 일·증거·남은 문제.
3. **루프/정체 감지** — OpenHands StuckDetector, CrewAI max_iter, LangGraph recursion_limit. 같은 오류 N회·같은 명령 반복·무진전 시간 → 끊는다.
4. **재계획** — evaluator-optimizer: 실패 원인을 진단하고 *다른 접근*으로 다시 위임. 반복 횟수 상한 필수.
5. **완료 전 검증** — Aider lint/test 루프, Codex AGENTS.md "what done means and how to verify". 총괄은 증거 없는 "완료"를 미확인으로 취급.
6. **승인 게이트** — Codex 승인 정책, OpenAI 가이드: 되돌릴 수 없는 작업은 사람 확인. 위험 우회 플래그 금지.
7. **실행 중 상태 Q&A** — Claude agent view, Orca: 작업을 끊지 않고 로그 기반으로 상태를 답한다(이미 구현됨: live-turn).
8. **도구 출력 노이즈 제거** — 모델은 출력 앞부분으로 판단한다. 반복 경고가 실제 결과를 밀어내면 판단이 흐려진다.
9. **브라우저 규율** — Playwright MCP: snapshot → ref. Codex 브라우저: 작게, 이름 붙은 상태, 끝나면 재확인.
10. **격리** — 같은 파일을 두 작업자에게 동시에 주지 않는다(worktree).

## 3. 이 앱에서 실제로 난 실패 (세션 265fa98f, 청소 사이트)
- 작업자 B가 ~30분 동안 `ao-browser text '#top[data-hero-mode="loop"]'`처럼 **선택자를 짐작**해 7개씩 병렬로 시도 → 전부 "요소를 찾을 수 없습니다". 마지막 400개 이벤트 중 ao-browser 관련 135회, `snapshot`은 한 번도 쓰지 않음.
- 도구 결과 44건 이상이 `(node:…) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set`로 시작. 원인: 앱이 CLI에 `NO_COLOR=1`을 넣고, 하위 셸에는 FORCE_COLOR가 들어와 node 기반 도구(ao-browser)가 매번 경고.
- 총괄은 한 번 위임하면 결과가 올 때까지 개입 수단이 없었다(세션 전체 10분 무이벤트 타임아웃뿐, 작업자는 이벤트를 계속 내므로 안 걸림).
- 합성 단계가 "추가 위임 금지"라서 실패해도 재계획 불가. 위임 본문은 총괄 재량(형식 강제 없음).
- 헤드리스 Grok은 허용 목록 밖 명령(`cd … &&`, `mkdir -p … && npx vite`)에서 **실행 전체가 취소**됨(이번 UX 배치 PID 6629도 마지막 vite 실행에서 이렇게 끝남).

## 4. CLI별 특성과 라우팅 (Codex · Claude Code · Grok Build)
| | 강점 | 약점 | 총괄 적합 | 작업자 적합 |
|---|---|---|---|---|
| **Codex (CLI·앱)** | 긴 구현·리팩터를 끝까지 밀어붙임, 테스트 돌리며 수정, AGENTS.md·Plan mode, OS 샌드박스(read-only/workspace-write)와 승인 정책이 명확, `/review` 코드 리뷰, 앱 브라우저 코멘트(요소 지정 피드백), 클라우드 태스크 | 말수 적고 보고가 짧음, 회사 공간 정책상 금지, 한도 소진 시 공백(11/4 리셋) | 중 (계획·검증은 무난, 사용자 대화는 건조) | **상**: 다파일 구현, 버그 수정, 테스트 통과까지, 리뷰 |
| **Claude Code** | 계획·분해·글쓰기, 서브에이전트(Task)·TodoWrite로 진행 관리, CLAUDE.md, hooks(편집/명령 전후 검증 강제), plan/acceptEdits 권한 모드, skills, `-p --output-format stream-json` 헤드리스 | 한도가 빠르게 소진, 긴 작업에서 범위가 넓어지는 경향, bbanana 계정 사용 금지 정책 | **상**: 위임 브리프 작성·검증·사용자 설명 | 상: 설계 문서, UI/카피, 리뷰, 복잡한 디버깅 |
| **Grok Build** | 빠르고 한도 여유, 미디어(이미지·영상) 라우팅, plan mode·서브에이전트·skills·hooks, `streaming-json` 헤드리스·ACP | 헤드리스에서 비허용 명령 시 **실행 전체 취소**, 선택자·명령 추측 반복 경향, 총괄로서 개입이 약함 | 하~중 (대체용) | 중: 탐색·조사·미디어·짧은 수정·상태 질의 |

**기본 라우팅 권장(앱 추천 기본값)**
- 총괄: Claude → (소진 시) Codex → Grok. Grok이 총괄일 때는 앱의 강제 규칙(브리프·정체 감지·검증 루프)에 더 의존한다.
- 구현/버그/테스트: Codex 작업자 우선, 없으면 Claude, 그다음 Grok.
- 설계·문서·리뷰·UI 카피: Claude 작업자.
- 미디어 생성·빠른 조사·로그 요약·상태 답변: Grok.
- 회사 공간: Codex 금지(기존 정책 유지). bbanana는 Claude에 쓰지 않음(기존 정책 유지).
- 같은 파일을 두 작업자에 동시에 주지 않는다. 독립 작업만 병렬.
