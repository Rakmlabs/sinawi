// The page of a browser window outside the app window (browser-window.ts): one BrowserPanel filling
// the window. Its socket (`/ws/browser`) brings this workspace's agents' browser commands, which the
// panel runs like an in-app one, and carries back what the app window must know: the user is using
// this window, picked elements for the chat, or wants the browser back inside the app.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { BrowserPanel } from "../BrowserPanel";
import { setBrowserWorkspace } from "../browser-agent";
import { browserRegistry } from "../browser-registry";
import { browserWindowSocketPath, closeThisBrowserWindow, forgetOutside, type BrowserWindowTarget } from "../browser-window";
import { appKeyProtocols, loadAppKey } from "../app-key";
import type { ComposerAttachment } from "../preview-attachments";
import { nextReconnectDelay, parseServerMessage } from "./socket";
import { t } from "../i18n";

const ignore = () => undefined;

export function BrowserWindowApp({ id, workspaceId }: BrowserWindowTarget) {
  const target = useRef<BrowserWindowTarget>({ id, workspaceId });
  // Before the panel mounts: the registry asks which workspace is on screen. The whole window is the
  // browser, so its shortcuts (⌘W closes a tab, ⌘T, ⌘L…) apply wherever the focus is in it.
  useState(() => { setBrowserWorkspace(workspaceId); browserRegistry.setDesktopFocused(true); return null; });
  useLayoutEffect(() => { document.title = t("bw.title"); }, []);
  const socket = useRef<WebSocket | undefined>(undefined);
  const [connected, setConnected] = useState(true);
  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let attempt = 0;
    let hadOpened = false;
    const connect = (refreshKey = false) => {
      timer = undefined;
      void loadAppKey(refreshKey).then(() => {
        if (disposed) return;
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${browserWindowSocketPath(target.current)}`, appKeyProtocols());
        socket.current = ws;
        ws.onopen = () => { attempt = 0; hadOpened = true; setConnected(true); if (document.hasFocus()) ws.send(JSON.stringify({ type: "focus" })); };
        ws.onmessage = (event) => {
          const message = parseServerMessage(event.data);
          if (message?.type === "browser-command") window.dispatchEvent(new CustomEvent("orchestra:browser-command", { detail: message }));
        };
        ws.onclose = () => {
          if (disposed) return;
          setConnected(false);
          clearTimeout(timer);
          timer = setTimeout(() => connect(true), nextReconnectDelay(attempt++, hadOpened));
        };
      });
    };
    connect();
    // The window the user works in is the one its workspace's agents use (when several are open).
    const focused = () => { send({ type: "focus" }); };
    window.addEventListener("focus", focused);
    window.addEventListener("pointerdown", focused, true);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focused);
      window.removeEventListener("pointerdown", focused, true);
      socket.current?.close();
    };
  }, [send]);
  const attach = useCallback((items: ComposerAttachment[]) => { send({ type: "attach", items }); }, [send]);
  const close = useCallback(() => closeThisBrowserWindow(target.current), []);
  // The last tab was closed: the window is done. Nothing is left to bring back into the app (a window
  // closed by its own close button does come back there, with its tabs).
  const finish = useCallback(() => {
    forgetOutside(target.current.workspaceId, target.current.id);
    try { localStorage.removeItem(`orchestra.browser.tabs.${target.current.id}`); } catch { /* nothing saved */ }
    close();
  }, [close]);
  // Back into the app window: it opens an in-app window with this id (the tabs are saved under it), then this one goes.
  const dock = useCallback(() => { if (send({ type: "dock" })) setTimeout(close, 150); }, [send, close]);
  return (
    <div className="browser-window-root">
      {!connected && <div className="browser-window-offline" role="status">{t("bw.offline")}</div>}
      <BrowserPanel instanceId={id} workspaceId={workspaceId} open onOpenChange={ignore} onLastTabClosed={finish} onAttach={attach}
        extra={<button type="button" className="browser-dock-back" title={t("bw.dockTitle")} disabled={!connected} onClick={dock}><PanelsTopLeft size={15} aria-hidden="true" />{t("bw.dock")}</button>} />
    </div>
  );
}
