type MenuHandlers = { reload: () => void; closeTab: () => void };
type MenuWindow = { __orchestraMenuReload?: () => void; __orchestraMenuCloseTab?: () => void };

/** Tracks mounted browser panels; the last focused one gets agent commands and shortcuts. */
export function createBrowserRegistry() {
  const mounted: string[] = [];
  const menus = new Map<string, MenuHandlers>();
  let active: string | undefined;
  let desktop = false;
  const listeners = new Set<() => void>();
  const current = () => (active && mounted.includes(active) ? active : mounted.at(-1));
  const emit = () => { for (const listener of listeners) listener(); };
  const install = (target?: MenuWindow) => {
    if (!target) return;
    target.__orchestraMenuReload = () => { const id = current(); if (id) menus.get(id)?.reload(); };
    target.__orchestraMenuCloseTab = () => { const id = current(); if (id) menus.get(id)?.closeTab(); };
  };
  return {
    mount(id: string) {
      if (!mounted.includes(id)) mounted.push(id);
      emit();
      return () => { const index = mounted.indexOf(id); if (index >= 0) mounted.splice(index, 1); menus.delete(id); emit(); };
    },
    activate(id: string) { if (active !== id) { active = id; emit(); } },
    isActive(id: string) { return current() === id; },
    active: current,
    count: () => mounted.length,
    /** True while the user's last click landed on a desktop browser window (not the chat). */
    setDesktopFocused(value: boolean) { desktop = value; },
    desktopFocused: () => desktop && mounted.length > 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    handlers(id: string, handlers: MenuHandlers, target?: MenuWindow) {
      menus.set(id, handlers); install(target);
      return () => { if (menus.get(id) === handlers) menus.delete(id); };
    },
  };
}

export const browserRegistry = createBrowserRegistry();
