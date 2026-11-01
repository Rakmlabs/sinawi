import { useQuotas } from "../QuotaContext";
import { quotaReturnCandidate } from "../quota-fallback";
import { useNow } from "./clock";
import { names } from "./labels";
import type { AgentId, Session } from "../../server/types";

/** "한도가 초기화되었습니다" offer; owns the clock so the reset moment re-renders only this banner. */
export function QuotaReturnBanner({ active, threshold, allowedAgents, busy, onReturn }: { active: Session; threshold: number; allowedAgents: AgentId[]; busy: boolean; onReturn: (eventId: string) => void }) {
  const { providers } = useQuotas();
  const now = useNow(1_000, active.status !== "running");
  const candidate = quotaReturnCandidate(active, providers, threshold, allowedAgents, now);
  if (!candidate) return null;
  return <div className="quota-return-banner" role="status">
    <span>{names[candidate.metadata!.from!]} 한도가 초기화되었습니다.</span>
    <button className="button light" disabled={busy} onClick={() => onReturn(candidate.id)}>{names[candidate.metadata!.from!]}로 돌아가기</button>
  </div>;
}
