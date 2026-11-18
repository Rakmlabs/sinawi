import { useRef } from "react";

type Handlers = Record<string, (...args: any[]) => any>;

/**
 * Stable stand-ins for callbacks rebuilt on every render: each forwards to the latest version, so a
 * memoized child (MessageList, Sidebar) sees the same functions while the composer re-renders the
 * app per keystroke. The set of keys must not change between renders.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const stable = useRef<T>(undefined);
  if (!stable.current) stable.current = stableHandlers(latest);
  return stable.current;
}

/** The forwarding object behind `useStableHandlers` (exported for tests). */
export function stableHandlers<T extends Handlers>(latest: { current: T }): T {
  const out = {} as Handlers;
  for (const key of Object.keys(latest.current)) out[key] = (...args: unknown[]) => latest.current[key](...args);
  return out as T;
}
