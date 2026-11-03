import { browserWorkspaceId } from "./browser-agent";

type MenuHandlers = { reload: () => void; closeTab: () => void };
type MenuWindow = { __orchestraMenuReload?: () => void; __orchestraMenuCloseTab?: () => void };

/**
 * Tracks mounted browser panels; the last focused one gets agent commands and shortcuts.
 * Panels belong to a workspace: only the workspace on screen has an active panel, and a
 * workspace the user is not in still has a primary panel for its own agents' commands.
 * A panel mounted without a workspace belongs to every workspace.
 */
export function createBrowserRegistry(onScreen: () => string | undefined = browserWorkspaceId) {
  const mounted: string[] = [];
  const spaces = new Map<string, string | undefined>();
  const menus = new Map<string, MenuHandlers>();
  const activeIn = new Map<string | undefined, string>();
  let desktop = false;
  const listeners = new Set<() => void>();
  const inSpace = (workspaceId: string | undefined) => mounted.filter((id) => { const own = spaces.get(id); return !own || !workspaceId || own === workspaceId; });
  const primary = (workspaceId: string | undefined) => {
    const list = inSpace(workspaceId);
    const chosen = activeIn.get(workspaceId);
    return chosen && list.includes(chosen) ? chosen : list.at(-1);
  };
  const current = () => primary(onScreen());
  const emit = () => { for (const listener of listeners) listener(); };
  const install = (target?: MenuWindow) => {
    if (!target) return;
    target.__orchestraMenuReload = () => { const id = current(); if (id) menus.get(id)?.reload(); };
    target.__orchestraMenuCloseTab = () => { const id = current(); if (id) menus.get(id)?.closeTab(); };
  };
  return {
    mount(id: string, workspaceId?: string) {
      if (!mounted.includes(id)) mounted.push(id);
      spaces.set(id, workspaceId);
      emit();
      return () => { const index = mounted.indexOf(id); if (index >= 0) mounted.splice(index, 1); spaces.delete(id); menus.delete(id); emit(); };
    },
    activate(id: string) {
      const workspaceId = spaces.get(id) ?? onScreen();
      if (activeIn.get(workspaceId) !== id) { activeIn.set(workspaceId, id); emit(); }
    },
    isActive(id: string) { return current() === id; },
    /** The panel that runs agent commands for `workspaceId` (on screen or not). */
    isPrimary(id: string, workspaceId: string | undefined) { return primary(workspaceId) === id; },
    active: current,
    count: () => inSpace(onScreen()).length,
    countIn: (workspaceId: string) => inSpace(workspaceId).length,
    /** True while the user's last click landed on a desktop browser window (not the chat). */
    setDesktopFocused(value: boolean) { desktop = value; },
    desktopFocused: () => desktop && inSpace(onScreen()).length > 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    handlers(id: string, handlers: MenuHandlers, target?: MenuWindow) {
      menus.set(id, handlers); install(target);
      return () => { if (menus.get(id) === handlers) menus.delete(id); };
    },
  };
}

export const browserRegistry = createBrowserRegistry();
