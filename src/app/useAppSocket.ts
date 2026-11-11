import { useEffect, useRef, useState } from "react";
import { nextReconnectDelay, parseServerMessage, type ServerMessage } from "./socket";

/**
 * Main `/ws` connection. Reconnects with exponential backoff + jitter (reset once a connection
 * opens; fast at first after an open connection drops, and right away on `online` or when the
 * window comes back to the front) and calls `onRetry` before every reconnect so state missed
 * while offline is reloaded.
 */
export function useAppSocket(onMessage: (message: ServerMessage) => void, onRetry: () => void): boolean {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onMessage, onRetry });
  handlers.current = { onMessage, onRetry };
  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let attempt = 0;
    /** Since the last open connection dropped: fast retries first (nextReconnectDelay). */
    let hadOpened = false;
    let open = false;
    function connect() {
      timer = undefined;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => { attempt = 0; hadOpened = true; open = true; setConnected(true); };
      ws.onmessage = (event) => {
        const message = parseServerMessage(event.data);
        if (message) handlers.current.onMessage(message);
      };
      ws.onclose = () => {
        open = false;
        setConnected(false);
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(retry, nextReconnectDelay(attempt++, hadOpened));
      };
    }
    function retry() {
      handlers.current.onRetry();
      connect();
    }
    // Back online or back in front: a pending retry should not wait out its backoff.
    const retryNow = () => {
      if (disposed || open || timer === undefined) return;
      if (document.visibilityState === "hidden") return;
      clearTimeout(timer);
      retry();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", retryNow);
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", retryNow);
      ws?.close();
    };
  }, []);
  return connected;
}
