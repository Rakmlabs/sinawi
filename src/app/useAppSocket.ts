import { useEffect, useRef, useState } from "react";
import { parseServerMessage, reconnectDelay, type ServerMessage } from "./socket";

/**
 * Main `/ws` connection. Reconnects with exponential backoff + jitter (reset once a connection
 * opens) and calls `onRetry` before every reconnect so state missed while offline is reloaded.
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
    function connect() {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => { attempt = 0; setConnected(true); };
      ws.onmessage = (event) => {
        const message = parseServerMessage(event.data);
        if (message) handlers.current.onMessage(message);
      };
      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          handlers.current.onRetry();
          connect();
        }, reconnectDelay(attempt++));
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return connected;
}
