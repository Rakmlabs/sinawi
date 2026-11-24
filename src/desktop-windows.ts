export type DesktopWindow = { id: string; x: number; y: number; w: number; h: number; z: number; minimized?: boolean; maximized?: boolean; snap?: "left" | "right" };
export const DESKTOP_STORE = "orchestra.browser.desktop";
/** Browser windows belong to a workspace (F1/F2): each keeps its own list. The first workspace also reads the pre-workspace list. */
export function desktopStoreKey(workspaceId: string) { return `${DESKTOP_STORE}.${workspaceId}`; }
export function loadWorkspaceWindows(read: (key: string) => string | null, workspaceId: string, isFirst: boolean): DesktopWindow[] {
  const own = read(desktopStoreKey(workspaceId));
  return loadWindows(own ?? (isFirst ? read(DESKTOP_STORE) : null));
}
export const MIN_W = 420, MIN_H = 300;
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function loadWindows(raw: string | null): DesktopWindow[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((w) => w && typeof w.id === "string" && w.kind !== "simulator").map((w) => ({ ...w, x: Number(w.x) || 0, y: Number(w.y) || 0, w: Math.max(MIN_W, Number(w.w) || 800), h: Math.max(MIN_H, Number(w.h) || 560), z: Number(w.z) || 1 })) : [];
  } catch { return []; }
}

export function newWindow(list: DesktopWindow[], area: { width: number; height: number }, id: string): DesktopWindow {
  const offset = (list.length % 6) * 28;
  const w = Math.max(MIN_W, Math.min(960, area.width - 80)), h = Math.max(MIN_H, Math.min(680, area.height - 80));
  return { id, x: 40 + offset, y: 24 + offset, w, h, z: topZ(list) + 1 };
}

export const topZ = (list: DesktopWindow[]) => list.reduce((max, w) => Math.max(max, w.z), 0);

/** Keeps at least the title bar on screen so a window can always be dragged back. */
export function clampPosition(win: DesktopWindow, area: { width: number; height: number }): DesktopWindow {
  return { ...win, x: Math.min(Math.max(win.x, 80 - win.w), area.width - 80), y: Math.min(Math.max(win.y, 0), area.height - 36) };
}

export function resizeWindow(start: DesktopWindow, edge: Edge, dx: number, dy: number): DesktopWindow {
  let { x, y, w, h } = start;
  if (edge.includes("e")) w = Math.max(MIN_W, start.w + dx);
  if (edge.includes("s")) h = Math.max(MIN_H, start.h + dy);
  if (edge.includes("w")) { w = Math.max(MIN_W, start.w - dx); x = start.x + (start.w - w); }
  if (edge.includes("n")) { h = Math.max(MIN_H, start.h - dy); y = start.y + (start.h - h); }
  return { ...start, x, y, w, h };
}

export type Snap = "left" | "right" | "max";
export type DesktopMode = "none" | Snap;
type Area = { width: number; height: number };

/**
 * What a snapped or maximized window shares the area with: the docked sidebar on the left (`left`),
 * the terminal at the bottom (`bottom`) and the chat beside it. `split` is the browser's share of
 * the width that is left; a folded chat keeps only its rail. A maximized window fills everything
 * else, unless the chat is open beside it (`chatBeside`): then it shares the width like a left snap.
 * Nothing of the app is ever laid over the page: a native page view draws above all app UI.
 */
export type DeskLayout = { left: number; bottom: number; split: number; chatCollapsed: boolean; chatBeside: boolean };
export const SPLIT_DEFAULT = 0.5;
export const SPLIT_MIN_BROWSER = 320, SPLIT_MIN_CHAT = 340;
/** Width of the folded chat's rail (.chat-rail). */
export const CHAT_RAIL = 48;
export const DEFAULT_LAYOUT: DeskLayout = { left: 0, bottom: 0, split: SPLIT_DEFAULT, chatCollapsed: false, chatBeside: false };

export const clampSplit = (value: number) => (Number.isFinite(value) ? Math.min(0.85, Math.max(0.15, value)) : SPLIT_DEFAULT);

/** A snapped window's width within `usable` px: both the page and the chat keep a workable minimum. */
export function clampSnapWidth(width: number, usable: number): number {
  if (usable < SPLIT_MIN_BROWSER + SPLIT_MIN_CHAT) return Math.round(usable / 2);
  return Math.round(Math.min(usable - SPLIT_MIN_CHAT, Math.max(SPLIT_MIN_BROWSER, width)));
}

/** Width of a snapped browser window. */
export function snapWidth(area: Area, layout: DeskLayout = DEFAULT_LAYOUT): number {
  const usable = Math.max(0, area.width - layout.left);
  if (layout.chatCollapsed) return Math.max(0, usable - CHAT_RAIL);
  return clampSnapWidth(usable * clampSplit(layout.split), usable);
}

/** Where a window is drawn: snapped/maximized windows fill part of the area, others use their own frame. */
export function frameOf(win: DesktopWindow, area: Area, layout: DeskLayout = DEFAULT_LAYOUT): { x: number; y: number; w: number; h: number } {
  const h = Math.max(0, area.height - layout.bottom);
  if (win.maximized) return { x: layout.left, y: 0, w: layout.chatBeside ? snapWidth(area, { ...layout, chatCollapsed: false }) : Math.max(0, area.width - layout.left), h };
  if (!win.snap) return { x: win.x, y: win.y, w: win.w, h: win.h };
  const w = snapWidth(area, layout);
  // The chat (or its rail) takes the other side, between the sidebar and the page for a right snap.
  return { x: win.snap === "left" ? layout.left : area.width - w, y: 0, w, h };
}

/** Snap toggles: pressing the same snap again restores the floating frame. */
export function applySnap(win: DesktopWindow, snap: Snap): DesktopWindow {
  if (snap === "max") return { ...win, maximized: !win.maximized, snap: undefined, minimized: false };
  return { ...win, maximized: false, snap: win.snap === snap ? undefined : snap, minimized: false };
}

/** The layout the workspace must adapt to: decided by visible maximized/snapped windows. */
export function desktopMode(list: DesktopWindow[]): DesktopMode {
  const visible = list.filter((w) => !w.minimized);
  if (visible.some((w) => w.maximized)) return "max";
  const snapped = visible.filter((w) => w.snap).sort((a, b) => b.z - a.z)[0];
  return snapped?.snap ?? "none";
}
