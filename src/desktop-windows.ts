export type DesktopWindow = { id: string; x: number; y: number; w: number; h: number; z: number; minimized?: boolean; maximized?: boolean; snap?: "left" | "right" };
export const DESKTOP_STORE = "orchestra.browser.desktop";
export const MIN_W = 420, MIN_H = 300;
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function loadWindows(raw: string | null): DesktopWindow[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((w) => w && typeof w.id === "string").map((w) => ({ ...w, x: Number(w.x) || 0, y: Number(w.y) || 0, w: Math.max(MIN_W, Number(w.w) || 800), h: Math.max(MIN_H, Number(w.h) || 560), z: Number(w.z) || 1 })) : [];
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

/** Where a window is drawn: snapped/maximized windows fill part of the area, others use their own frame. */
export function frameOf(win: DesktopWindow, area: Area): { x: number; y: number; w: number; h: number } {
  const half = Math.round(area.width / 2);
  if (win.maximized) return { x: 0, y: 0, w: area.width, h: area.height };
  if (win.snap === "left") return { x: 0, y: 0, w: half, h: area.height };
  if (win.snap === "right") return { x: area.width - half, y: 0, w: half, h: area.height };
  return { x: win.x, y: win.y, w: win.w, h: win.h };
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
