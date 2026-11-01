/** Main app WebSocket: reconnect timing and frame parsing (pure, unit-tested). */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;

/**
 * Exponential backoff with "equal jitter": the delay for `attempt` (0-based) lies in
 * [ceiling / 2, ceiling], where ceiling = min(cap, base * 2^attempt).
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random, base = RECONNECT_BASE_MS, cap = RECONNECT_CAP_MS): number {
  const step = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  const ceiling = Math.min(cap, base * 2 ** Math.min(step, 30));
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + unit * (ceiling / 2));
}

export type ServerMessage = { type: string; [key: string]: any };

/** A frame that is not JSON or has no string `type` is logged and dropped instead of throwing. */
export function parseServerMessage(data: unknown, warn: (...args: unknown[]) => void = console.warn): ServerMessage | undefined {
  if (typeof data !== "string") { warn("[orchestra] ignored non-text WebSocket frame"); return undefined; }
  let message: unknown;
  try { message = JSON.parse(data); } catch (error) {
    warn("[orchestra] ignored malformed WebSocket frame:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof (message as { type?: unknown }).type !== "string") {
    warn("[orchestra] ignored WebSocket frame without a type");
    return undefined;
  }
  return message as ServerMessage;
}
