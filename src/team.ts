import type { AgentId, AgentSelection } from "../server/types";
import { normalizeWorkerConfigs } from "../server/workers";
import { t } from "./i18n";

const names = { codex: "Codex", claude: "Claude", grok: "Grok Build" };

export function teamAvailabilityWarning(allowedAgents: AgentId[], unavailable: AgentId[]): string {
  if (!allowedAgents.length) return t("team.noAllowedAgents");
  return unavailable.length ? t("team.cliMissing", { agents: [...new Set(unavailable)].map((id) => names[id]).join(", ") }) : "";
}

export function changeWorkerConfig(crew: AgentSelection[], index: number, next: AgentSelection): AgentSelection[] {
  const updated = crew.map((worker, i) => i === index ? { ...next, id: worker.id, label: worker.agent === next.agent ? next.label : undefined } : worker);
  return normalizeWorkerConfigs(updated.map((worker) => worker.agent), updated);
}

/** WebKit/Chromium/Firefox wording for a fetch that never got a response (server restarting, request dropped). */
export function isNetworkFailure(message: string): boolean {
  return /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.?|cancelled|취소됨)$/i.test(message.trim());
}
