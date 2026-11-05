import type { AgentId } from "./types.js";

/**
 * What each CLI can do that the others cannot. The lead reads this and decides by itself which
 * worker (and which CLI) a piece of work needs; the app does not route by keywords. Facts only:
 * no "if the user says X, use Y" rules.
 */
export const AGENT_CAPABILITIES: Record<AgentId, string> = {
  claude: "Claude Code. 설치된 Claude 스킬을 Skill 도구로 연다(아래 스킬 목록의 [claude] 표시). 단, Claude Design `/design`은 disable-model-invocation 때문에 모델이나 Skill 도구가 호출할 수 없다. 동의 여부로 이 headless 제한을 풀 수 없다. 디자인·목업은 Claude 또는 Codex 워커가 로컬 스킬 frontend-design, impeccable, canvas-design, web-artifacts-builder 등을 사용해 HTML·목업 아티팩트로 만든다. 사용자가 자기 터미널에서 대화형 `/design`을 여는 것은 선택 가능한 수동 단계일 뿐 작업의 필수 조건이 아니다. Figma·플러그인 MCP, 긴 맥락 읽기, 설계·리뷰·문서에 강하다.",
  codex: "Codex CLI. apply_patch 기반의 빠르고 정확한 코드 수정, 테스트·빌드 반복, 대규모 리팩터에 강하다. Codex 스킬([codex] 표시)을 쓴다. frontend-design, impeccable, canvas-design, web-artifacts-builder 같은 로컬 디자인 스킬을 전달받아 HTML·목업 아티팩트를 만들 수 있다.",
  grok: "Grok Build. 이미지·영상 생성 도구(미디어)가 있는 유일한 CLI다. 실시간 웹·X 검색과 리서치에 강하다. Grok 스킬([grok] 표시)을 쓴다.",
};

/**
 * Lead prompt section: who can be hired and what each one can do. The lead may hand work to any
 * allowed CLI, on the team or not; the app adds that worker when the brief names it.
 */
export function capabilityCatalog(allowed: readonly AgentId[], team: readonly AgentId[]): string {
  if (!allowed.length) return "";
  const lines = allowed.map((agent) => `- ${agent}${team.includes(agent) ? " (지금 팀에 있음)" : " (팀에 없음: 위임하면 앱이 워커를 만든다)"}: ${AGENT_CAPABILITIES[agent]}`);
  return `\n\n## 쓸 수 있는 CLI와 각자 할 수 있는 일
누구에게 맡길지는 당신이 판단합니다. 앱은 키워드로 대신 고르지 않습니다. 작업에 필요한 기능·스킬을 가진 CLI를 고르고, 지금 팀에 없어도 그 CLI 이름으로 위임하면 됩니다(태그의 to에 CLI 이름 claude·codex·grok, 도구가 있으면 delegate_task의 agent). 사용자가 특정 CLI의 기능(예: 어떤 CLI의 스킬·슬래시 명령)을 말하면, 그것을 가진 CLI의 워커에게 맡기고 브리프에 그 기능을 쓰라고 적습니다. 그 워커가 해 보고도 안 되면 무엇이 막혔는지 사용자에게 그대로 알립니다.
${lines.join("\n")}
이 작업공간에서 허용되지 않은 CLI는 앱이 막습니다. 팀에 없는 CLI는 설치와 로그인이 확인된 경우에만 워커로 추가합니다. 준비되지 않았으면 앱이 알려 주는 설치·로그인 원인을 사용자에게 전달하세요.`;
}
