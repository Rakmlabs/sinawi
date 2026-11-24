import { useEffect, useRef, useState } from "react";
import { BrowserDesktop, type DesktopRequest } from "../BrowserDesktop";
import { claimCommand, holdCommand, type AgentCommand } from "../browser-agent";
import { browserRegistry } from "../browser-registry";
import { useDesktopHost } from "../desktop-host";
import { DOCK_EVENT, forgetOutside, rememberedOutside, type BrowserWindowTarget } from "../browser-window";
import { desktopStoreKey, loadWorkspaceWindows, newWindow } from "../desktop-windows";
import { t } from "../i18n";

const IDLE: DesktopRequest = { n: 0 };
const ignore = () => undefined;

/**
 * Every workspace's browser windows, one desktop each. The workspace on screen shows its windows;
 * any other workspace that was visited or whose agent used the browser keeps its windows out of
 * sight, pages laid out behind the app, so its agents keep working while the user is elsewhere and
 * its tabs are still there when the user comes back. Pages never cross workspaces.
 */
export function WorkspaceDesktops({ current, workspaceIds, firstId }: { current: string; workspaceIds: string[]; firstId?: string }) {
  const host = useDesktopHost();
  const [alive, setAlive] = useState<string[]>([current]);
  const [requests, setRequests] = useState<Record<string, DesktopRequest>>({});
  const list = alive.includes(current) ? alive : [...alive, current];
  useEffect(() => { setAlive((old) => (old.includes(current) ? old : [...old, current])); }, [current]);
  const currentRef = useRef(current); currentRef.current = current;
  const idsRef = useRef(workspaceIds); idsRef.current = workspaceIds;
  const aliveRef = useRef(list); aliveRef.current = list;
  const firstRef = useRef(firstId); firstRef.current = firstId;
  // A window outside the app comes back for a workspace that has no desktop mounted: put it in that
  // workspace's saved list, where its desktop finds it on the next visit (a mounted one adds it itself).
  useEffect(() => {
    const dock = (event: Event) => {
      const target = (event as CustomEvent<BrowserWindowTarget>).detail;
      if (!target?.id || !idsRef.current.includes(target.workspaceId) || aliveRef.current.includes(target.workspaceId)) return;
      forgetOutside(target.workspaceId, target.id);
      const saved = loadWorkspaceWindows((key) => localStorage.getItem(key), target.workspaceId, target.workspaceId === firstRef.current);
      if (saved.some((item) => item.id === target.id)) return;
      localStorage.setItem(desktopStoreKey(target.workspaceId), JSON.stringify([...saved, newWindow(saved, { width: window.innerWidth, height: window.innerHeight }, target.id)]));
    };
    window.addEventListener(DOCK_EVENT, dock);
    return () => window.removeEventListener(DOCK_EVENT, dock);
  }, []);
  // An agent of a workspace that is not on screen and has no browser window yet: open one there.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<AgentCommand>).detail;
      const workspaceId = command?.workspaceId;
      if (!command?.id || !workspaceId || workspaceId === currentRef.current) return;
      if (!idsRef.current.includes(workspaceId)) {
        if (claimCommand(command.id)) void fetch("/api/browser/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: command.id, ok: false, error: t("ws.browserNoWorkspace") }) }).catch(() => undefined);
        return;
      }
      if (browserRegistry.countIn(workspaceId) > 0) return;
      holdCommand(command);
      // Its browser was moved out of the app and that window is gone: the command brings it back in
      // (the dock listeners put it on that workspace's desktop, mounted or saved) instead of a second one.
      const outside = rememberedOutside(workspaceId)[0];
      if (outside) window.dispatchEvent(new CustomEvent(DOCK_EVENT, { detail: { id: outside, workspaceId } }));
      setAlive((old) => (old.includes(workspaceId) ? old : [...old, workspaceId]));
      if (!outside) setRequests((old) => ({ ...old, [workspaceId]: { n: (old[workspaceId]?.n ?? 0) + 1 } }));
    };
    window.addEventListener("orchestra:browser-command", onCommand);
    return () => window.removeEventListener("orchestra:browser-command", onCommand);
  }, []);
  return <>{list.filter((id) => workspaceIds.includes(id)).map((id) => {
    const onScreen = id === current && host?.workspaceId === id ? host : undefined;
    return <BrowserDesktop key={id} workspaceId={id} firstWorkspace={id === firstId} background={id !== current}
      onAttach={onScreen?.onAttach ?? ignore} request={onScreen?.request ?? requests[id] ?? IDLE}
      onModeChange={onScreen?.onModeChange ?? ignore} room={onScreen?.layout} />;
  })}</>;
}
