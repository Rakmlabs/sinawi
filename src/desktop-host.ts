import { useSyncExternalStore } from "react";
import type { DesktopMode } from "./desktop-windows";
import type { DesktopRequest } from "./BrowserDesktop";
import type { ComposerAttachment } from "./preview-attachments";

/**
 * What the workspace on screen gives its browser windows. The windows live above WorkspaceApp (so
 * another workspace's windows outlive a switch and keep serving that workspace's agents), and the
 * WorkspaceApp on screen publishes its part here.
 */
export type DesktopHost = {
  workspaceId: string;
  onAttach: (items: ComposerAttachment[]) => void;
  request: DesktopRequest;
  /** `browserWidth`: how wide the snapped window is drawn (0 unless snapped left or right). */
  onModeChange: (mode: DesktopMode, browserWidth: number) => void;
  /** What snapped and maximized windows leave room for (desktop-windows.ts DeskLayout, minus the split). */
  layout: { left: number; bottom: number; chatCollapsed: boolean; chatBeside: boolean };
};

let host: DesktopHost | undefined;
const listeners = new Set<() => void>();

export function setDesktopHost(next: DesktopHost | undefined) {
  host = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useDesktopHost = () => useSyncExternalStore(subscribe, () => host);
