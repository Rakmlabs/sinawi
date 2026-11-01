import type { ProviderQuota } from '../server/quota';
import type { AgentId, Session, SessionEvent } from '../server/types';
import { remainingQuota } from './quota-data';

/** A reset is an invitation to restore, never an automatic team change. */
export function quotaReturnCandidate(session: Session | undefined, quotas: ProviderQuota[], threshold: number, allowed: AgentId[], now = Date.now()): SessionEvent | undefined {
  if (!session || session.status === 'running') return;
  const event = [...session.events].reverse().find((item) => item.type === 'handoff');
  const metadata = event?.metadata;
  if (!metadata?.quotaFallback || metadata.undone || !metadata.from || !allowed.includes(metadata.from)) return;
  const remaining = remainingQuota(quotas.find((provider) => provider.agent === metadata.from), now);
  if (remaining !== undefined) return remaining > threshold ? event : undefined;
  return metadata.resetsAt && metadata.resetsAt * 1000 <= now ? event : undefined;
}
