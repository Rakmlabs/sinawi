/** Collapsed and focus-hidden rails stay closed until an explicit click. Pointer hover does not open them. */
export function railCollapsed(sidebarCollapsed: boolean, focusMode: boolean, pinnedOpen: boolean): boolean {
  if (pinnedOpen) return false;
  return sidebarCollapsed || focusMode;
}

export function afterEdgeClick(): { sidebarCollapsed: false; pinnedOpen: true } {
  return { sidebarCollapsed: false, pinnedOpen: true };
}

export function afterRailToggle(hidden: boolean): { sidebarCollapsed: boolean; pinnedOpen: boolean } {
  return hidden
    ? { sidebarCollapsed: false, pinnedOpen: true }
    : { sidebarCollapsed: true, pinnedOpen: false };
}

export function railToggleLabel(collapsed: boolean): "사이드바 펼치기" | "사이드바 접기" {
  return collapsed ? "사이드바 펼치기" : "사이드바 접기";
}
