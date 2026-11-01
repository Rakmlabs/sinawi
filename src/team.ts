import type { AgentId, AgentSelection } from "../server/types";
import { normalizeWorkerConfigs } from "../server/workers";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };

export function teamAvailabilityWarning(allowedAgents: AgentId[], unavailable: AgentId[]): string {
  if (!allowedAgents.length) return "이 공간에서 팀을 실행하려면 설정에서 에이전트를 한 개 이상 허용하세요.";
  return unavailable.length ? `${[...new Set(unavailable)].map((id) => names[id]).join(", ")} CLI를 찾을 수 없습니다. 설치·로그인한 뒤 새로고침하거나 사용 가능한 에이전트로 수정하세요.` : "";
}

export function changeWorkerConfig(crew: AgentSelection[], index: number, next: AgentSelection): AgentSelection[] {
  const updated = crew.map((worker, i) => i === index ? { ...next, id: worker.id, label: worker.agent === next.agent ? next.label : undefined } : worker);
  return normalizeWorkerConfigs(updated.map((worker) => worker.agent), updated);
}

/** WebKit/Chromium/Firefox wording for a fetch that never got a response (server restarting, request dropped). */
export function isNetworkFailure(message: string): boolean {
  return /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.?|cancelled|취소됨)$/i.test(message.trim());
}
