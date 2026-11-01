import { initialQuotaState, quotaStateReducer } from "./quota-state";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useReducer, type ReactNode } from "react";
import type { AgentId } from "../server/types";
import type { ProviderQuota } from "../server/quota";
import { remainingQuota } from "./quota-data";

const QuotaContext = createContext<{ providers: ProviderQuota[]; loading: boolean; refreshing: boolean; error: string; reload: () => Promise<void>; refreshClaude: () => Promise<void> }>({ providers: [], loading: true, refreshing: false, error: "", reload: async () => {}, refreshClaude: async () => {} });
export const useQuotas = () => useContext(QuotaContext);
export function QuotaProvider({ children }: { children: ReactNode }) {
  const [{ providers, loading, error }, dispatch] = useReducer(quotaStateReducer, initialQuotaState);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const probeInFlight = useRef(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  const request = useCallback(async (probe = false) => {
    if (!probe && (inFlight.current || probeInFlight.current)) return;
    const id = ++requestId.current;
    dispatch({ type: "start", id });
    if (!probe) inFlight.current = true;
    try {
      const response = await fetch(probe ? "/api/limits/refresh" : "/api/limits", probe ? { method: "POST" } : undefined);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "남은 한도를 불러오지 못했습니다.");
      if (active.current) dispatch({ type: "success", id, providers: Array.isArray(payload.providers) ? payload.providers : [] });
    } catch (reason) {
      if (active.current) dispatch({ type: "error", id, error: reason instanceof Error ? reason.message : "남은 한도를 불러오지 못했습니다." });
    } finally { if (!probe) inFlight.current = false;  }
  }, []);
  const reload = useCallback(() => request(), [request]);
  const refreshClaude = useCallback(async () => {
    if (probeInFlight.current) return;
    probeInFlight.current = true;
    setRefreshing(true);
    await request(true);
    probeInFlight.current = false;
    if (active.current) setRefreshing(false);
  }, [request]);
  useEffect(() => {
    active.current = true;
    void reload();
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 30_000);
    const focus = () => void reload();
    window.addEventListener("focus", focus);
    return () => { active.current = false; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [reload]);
  return <QuotaContext.Provider value={{ providers, loading, refreshing, error, reload, refreshClaude }}>{children}</QuotaContext.Provider>;
}
export function RemainingChip({ agent }: { agent: AgentId }) {
  const { providers } = useQuotas();
  const provider = providers.find((item) => item.agent === agent);
  const remaining = remainingQuota(provider);
  if (remaining === undefined) return null;
  return <span className={`remaining-chip${remaining < 20 ? " low" : ""}`} title={`남은 한도 ${remaining.toFixed(1)}% · 마지막 확인 ${provider?.updatedAt ?? "정보 없음"}`} aria-label={`남은 한도 ${remaining.toFixed(1)}%`}>{remaining < 1 && remaining > 0 ? "<1" : Math.floor(remaining)}%</span>;
}
