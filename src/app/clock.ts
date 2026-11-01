import { useEffect, useState } from "react";

type Listener = (now: number) => void;
type Ticker = { listeners: Set<Listener>; timer: ReturnType<typeof setInterval> };

const tickers = new Map<number, Ticker>();

/** One shared interval per period, started by the first subscriber and stopped with the last. */
export function subscribeClock(intervalMs: number, listener: Listener): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const listeners = new Set<Listener>();
    const timer = setInterval(() => { const now = Date.now(); for (const notify of listeners) notify(now); }, intervalMs);
    ticker = { listeners, timer };
    tickers.set(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    const current = tickers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) { clearInterval(current.timer); tickers.delete(intervalMs); }
  };
}

export function activeClockCount(): number { return tickers.size; }

/**
 * Current time that re-renders only the calling component. Use it in the small leaf that shows a
 * clock, never in a container, so a tick does not re-render the whole tree. `enabled: false`
 * freezes the value (finished timers need no ticks).
 */
export function useNow(intervalMs = 1_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribeClock(intervalMs, setNow);
  }, [intervalMs, enabled]);
  return now;
}
