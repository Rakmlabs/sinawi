import { TeamBar } from "../TeamBar";
import { useQuotas } from "../QuotaContext";
import { automaticTeamDefaults } from "../workspaces";
import { normalizeWorkerConfigs } from "../../server/workers";
import { useNow } from "./clock";
import type { RoutingRecommendation, RoutingSettings } from "../../server/routing";
import type { AgentId, AgentSelection, Session, WorkspaceId } from "../../server/types";

export type TeamBarSlotProps = {
  workspaceId: WorkspaceId;
  active: Session | undefined;
  pendingRecommendation: RoutingRecommendation | undefined;
  mode: "auto" | "manual";
  manual: { agent: AgentId; model: string; reasoningEffort: string; workers: AgentId[]; workerConfigs: AgentSelection[] };
  availableAgents: AgentId[];
  quotaFallback: boolean;
  quotaThreshold: number;
  routingSettings: RoutingSettings | undefined;
  busy: boolean;
  /** Opens the advanced session settings dialog. */
  onAdvanced?: () => void;
  onSave: (orchestrator: AgentSelection, workers: AgentSelection[]) => Promise<boolean>;
};

/**
 * Team picker in the composer bottom bar. The automatic default depends on quota windows expiring, so only this
 * slot keeps a (coarse, 30 s — the quota refresh period) clock, and only while that default shows.
 */
export function TeamBarSlot({ workspaceId, active, pendingRecommendation, mode, manual, availableAgents, quotaFallback, quotaThreshold, routingSettings, busy, onAdvanced, onSave }: TeamBarSlotProps) {
  const { providers } = useQuotas();
  const automaticShown = !active && !pendingRecommendation && mode === "auto";
  const now = useNow(30_000, automaticShown);
  const orchestrator = active
    ? { agent: active.agent, model: active.model, reasoningEffort: active.reasoningEffort }
    : pendingRecommendation?.orchestrator ?? (mode === "auto" ? automaticTeamDefaults(
      workspaceId,
      availableAgents,
      providers,
      quotaFallback,
      quotaThreshold,
      now,
      routingSettings ? {
        grok: routingSettings.modelOptions.grok.authStatus,
        claude: routingSettings.modelOptions.claude.authStatus,
        codex: routingSettings.modelOptions.codex.authStatus,
      } : undefined,
    ) : { agent: manual.agent, model: manual.model, reasoningEffort: manual.reasoningEffort });
  const workers = active ? normalizeWorkerConfigs(active.workers, active.workerConfigs) : pendingRecommendation?.workers ?? normalizeWorkerConfigs(manual.workers, manual.workerConfigs);
  return <TeamBar orchestrator={orchestrator} workers={workers} settings={routingSettings} availableAgents={availableAgents} disabled={busy} running={active?.status === "running"} automatic={automaticShown} onAdvanced={onAdvanced} onSave={onSave} />;
}
