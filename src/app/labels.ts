// User-visible labels shared by the app views (ko; a ko/en dictionary will replace these).
import type { EventType, SessionStatus } from "../../server/types";

export const names: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok Build",
  user: "나",
  system: "시스템",
};

export const statusLabels: Record<SessionStatus, string> = {
  running: "진행 중",
  done: "완료",
  error: "오류",
  stopped: "중지됨",
};

export const eventLabels: Record<EventType, string> = {
  message: "메시지",
  tool: "도구 사용",
  command: "명령 실행",
  edit: "파일 수정",
  status: "상태",
  error: "오류",
  warning: "경고",
  delegation: "작업 위임",
  handoff: "오케스트라 변경",
};

export const promptChips: [label: string, text: string][] = [
  ["앱 만들기", "새 앱을 기획하고 만드는 것을 도와주세요. 먼저 작업 폴더를 살펴보고 계획을 제안해 주세요."],
  ["코드 살펴보기", "이 코드의 구조를 살펴보고 설명해 주세요. 다음으로 가장 도움이 될 개선 사항을 찾아 주세요."],
  ["팀과 작업하기", "선택한 작업 에이전트와 함께 이 프로젝트를 검토해 주세요. 독립적인 검토 영역을 나누어 맡기고 결과를 요약해 주세요."],
];
