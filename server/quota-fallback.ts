import type { ProviderQuota } from "./quota.js";
import type { AgentId, WorkspaceId } from "./types.js";

export const defaultFallbackOrder: Record<AgentId, AgentId[]> = {
  codex: ["claude", "grok"],
  claude: ["codex", "grok"],
  grok: ["claude", "codex"],
};

export interface QuotaExhaustion {
  exhausted: boolean;
  remainingPercent?: number;
  resetsAt?: number;
}

/** Recognizes quota errors in both human-readable CLI output and JSON event lines. */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) jsonStrings(item, out);
  return out;
}

export function isQuotaExhaustion(value: unknown): boolean {
  let text = value instanceof Error
    ? `${value.message}\n${String((value as Error & { stderr?: unknown }).stderr ?? "")}`
    : typeof value === "string" ? value : JSON.stringify(value ?? "");
  try {
    const event = JSON.parse(text) as Record<string, unknown>;
    // Only the event's text counts: a timing like `"print_import_ms":429` in Claude's init line is not an HTTP 429.
    if (event && typeof event === "object") text = jsonStrings(event).join("\n");
    if (event.type === "rate_limit_event" || event.type === "rate_limit") {
      const info = event.rate_limit_info && typeof event.rate_limit_info === "object" ? event.rate_limit_info as Record<string, unknown> : undefined;
      return event.status === "rejected" || info?.status === "rejected"
        || /usage[ _-]?limit|quota|rate.limit|429/iu.test(String(event.error ?? event.message ?? ""));
    }
    if (event.status === 429 || event.code === "rate_limit" || event.code === "rate_limit_exceeded") return true;
  } catch { /* Human-readable CLI output is checked below. */ }
  return /usage[ _-]?limit(?: reached| exceeded)?|quota.{0,24}(?:exceeded|exhausted|reached|limit)|insufficient_quota|rate_limit(?:_exceeded)?\b|rate limit (?:reached|exceeded)|too many requests|\b429\b/iu.test(text);
}

export function exhaustionFromQuota(quota: ProviderQuota | undefined, threshold = 3, now = Date.now() / 1_000): QuotaExhaustion {
  if (!quota?.windows.length) return { exhausted: false };
  // Within a window usage only grows, so an old reading still bounds what is left until that window
  // resets; only a window with no known reset goes stale (after a day nothing says it still applies).
  const stale = Boolean(quota.updatedAt && Date.parse(quota.updatedAt) < now * 1_000 - 24 * 60 * 60 * 1_000);
  const active = quota.windows.filter((window) => window.resetsAt === undefined ? !stale : window.resetsAt > now);
  if (!active.length) return { exhausted: false };
  const limiting = [...active].sort((left, right) => left.remainingPercent - right.remainingPercent)[0]!;
  return {
    exhausted: limiting.remainingPercent <= Math.max(0, Math.min(100, threshold)),
    remainingPercent: limiting.remainingPercent,
    ...(limiting.resetsAt === undefined ? {} : { resetsAt: limiting.resetsAt }),
  };
}

function usableRemaining(quota: ProviderQuota | undefined, now = Date.now() / 1_000): number {
  if (!quota?.windows.length || quota.unavailableReason) return -1;
  const active = quota.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now);
  return active.length ? Math.min(...active.map((window) => window.remainingPercent)) : -1;
}

export function selectQuotaFallback(
  exhaustedAgent: AgentId,
  allowedAgents: readonly AgentId[],
  authenticatedAgents: readonly AgentId[],
  quotas: readonly ProviderQuota[],
  order?: Partial<Record<AgentId, AgentId[]>>,
  // Kept for callers; the workspace's allowed agents already carry its policy.
  _workspaceId?: WorkspaceId,
  threshold = 3,
): AgentId | undefined {
  const allowed = new Set(allowedAgents);
  const authenticated = new Set(authenticatedAgents);
  const preferred = order?.[exhaustedAgent] ?? defaultFallbackOrder[exhaustedAgent];
  const rank = new Map(preferred.map((agent, index) => [agent, index]));
  return preferred
    .filter((agent) => agent !== exhaustedAgent && allowed.has(agent) && authenticated.has(agent))
    .filter((agent) => !exhaustionFromQuota(quotas.find((quota) => quota.agent === agent), threshold).exhausted)
    .sort((left, right) => usableRemaining(quotas.find((quota) => quota.agent === right)) - usableRemaining(quotas.find((quota) => quota.agent === left))
      || (rank.get(left) ?? 99) - (rank.get(right) ?? 99))[0];
}

/** Maps broad capability tiers without assuming provider-specific model catalogs are complete. */
export function equivalentFallbackModel(
  from: AgentId,
  to: AgentId,
  model?: string,
  reasoningEffort?: string,
): { model?: string; reasoningEffort?: string } {
  const highTier = reasoningEffort === "high" || reasoningEffort === "xhigh" || /opus|pro|max|gpt-5|o1|o3/iu.test(model ?? "");
  // No model picked means the CLI's own default, which is each provider's main model: keep that
  // rather than reading "unspecified" as a small tier (it sent coding work to Haiku).
  if (!model && !highTier) return { model: undefined, reasoningEffort: undefined };
  if (to === "claude") return { model: highTier ? "sonnet" : "haiku", reasoningEffort: undefined };
  if (to === "codex") return { model: undefined, reasoningEffort: highTier || from === "claude" && /opus/iu.test(model ?? "") ? "high" : "medium" };
  return { model: highTier ? "grok-4.7" : "grok-4.7-build-fast", reasoningEffort: undefined };
}
