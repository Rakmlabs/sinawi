import type { ProviderQuota } from "../server/quota";
export type QuotaState = { providers: ProviderQuota[]; loading: boolean; error: string; requestId: number };
export const initialQuotaState: QuotaState = { providers: [], loading: true, error: "", requestId: 0 };
type Action = { type: "start"; id: number } | { type: "success"; id: number; providers: ProviderQuota[] } | { type: "error"; id: number; error: string };
export function quotaStateReducer(state: QuotaState, action: Action): QuotaState {
  if (action.type === "start") return { ...state, requestId: action.id };
  if (action.id !== state.requestId) return state;
  return action.type === "success" ? { ...state, providers: action.providers, loading: false, error: "" } : { ...state, loading: false, error: action.error };
}
