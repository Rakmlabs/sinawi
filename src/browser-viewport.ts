import { t } from "./i18n";
/** Device frame for the in-app browser. Desktop is the full panel; other presets are a centered frame. */

export const VIEWPORT_STORE = "orchestra.browser.viewport";

export type ViewportPreset = "iphone" | "tablet" | "custom";
export type ViewportChoice = {
  mode: "desktop" | "device";
  preset: ViewportPreset;
  width: number;
  height: number;
};

export const IPHONE_SIZE = { width: 390, height: 844 };
export const TABLET_SIZE = { width: 768, height: 1024 };

export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export const DEFAULT_VIEWPORT: ViewportChoice = { mode: "desktop", preset: "iphone", ...IPHONE_SIZE };

export type Emulation = { mobile: boolean; touch: boolean; userAgent: string; platform: string };

function clampSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(4000, Math.max(200, Math.round(value)));
}

export function parseViewportArg(raw: string, current: ViewportChoice = DEFAULT_VIEWPORT): ViewportChoice | { error: string } {
  const value = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!value) return { error: "크기가 필요합니다. 예: ao-browser viewport iphone | tablet | desktop | 390x844" };
  if (value === "iphone" || value === "phone" || value === "mobile" || value === "app") return { mode: "device", preset: "iphone", ...IPHONE_SIZE };
  if (value === "tablet" || value === "pad" || value === "ipad") return { mode: "device", preset: "tablet", ...TABLET_SIZE };
  if (value === "desktop" || value === "web" || value === "full") return { ...current, mode: "desktop" };
  const match = /^(\d{2,5})[x×*](\d{2,5})$/.exec(value);
  if (!match) return { error: `알 수 없는 뷰포트 '${raw}'. iphone, tablet, desktop, 390x844 중 하나를 쓰세요.` };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 200 || height < 200 || width > 4000 || height > 4000) return { error: `뷰포트 크기가 범위를 벗어났습니다: ${width}x${height}. 한 변은 200–4000 입니다.` };
  return { mode: "device", preset: "custom", width, height };
}

export function isViewportError(value: ViewportChoice | { error: string }): value is { error: string } {
  return "error" in value;
}

/** Device mode ↔ full-width desktop, keeping the last phone/tablet/custom size. */
export function toggleViewport(current: ViewportChoice): ViewportChoice {
  return { ...current, mode: current.mode === "device" ? "desktop" : "device" };
}

export function readViewport(raw: string | null): ViewportChoice {
  if (!raw) return DEFAULT_VIEWPORT;
  try {
    const data = JSON.parse(raw) as { mode?: string; preset?: string; width?: number; height?: number };
    const mode = data.mode === "device" ? "device" : "desktop";
    if (data.preset === "tablet") return { mode, preset: "tablet", ...TABLET_SIZE };
    if (data.preset === "custom") return { mode, preset: "custom", width: clampSize(Number(data.width), 390), height: clampSize(Number(data.height), 844) };
    return { mode, preset: "iphone", ...IPHONE_SIZE };
  } catch {
    return DEFAULT_VIEWPORT;
  }
}

export function serializeViewport(choice: ViewportChoice): string {
  return JSON.stringify({ mode: choice.mode, preset: choice.preset, width: choice.width, height: choice.height });
}

/** Mobile presets (and phone/tablet-sized custom frames) override the user agent and enable touch. */
export function emulationOf(choice: ViewportChoice): Emulation {
  if (choice.mode === "desktop") return { mobile: false, touch: false, userAgent: "", platform: "" };
  const kind = choice.preset === "iphone" ? "iphone" : choice.preset === "tablet" ? "tablet" : choice.width <= 500 ? "iphone" : choice.width < 1100 ? "tablet" : "desktop";
  if (kind === "iphone") return { mobile: true, touch: true, userAgent: IPHONE_UA, platform: "iPhone" };
  if (kind === "tablet") return { mobile: true, touch: true, userAgent: IPAD_UA, platform: "iPad" };
  return { mobile: false, touch: false, userAgent: "", platform: "" };
}

/** Width 0 unlocks the page meta. A device width is the CSS pixel width the iframe must report. */
export function emulationPayload(choice: ViewportChoice): Emulation & { width: number; height: number } {
  const emu = emulationOf(choice);
  if (choice.mode !== "device") return { ...emu, width: 0, height: 0 };
  return { ...emu, width: choice.width, height: choice.height };
}

/** Below this, a short window used to clip the phone frame. */
export const MIN_DEVICE_SCALE = 0.05;

/**
 * Layout size stays the device CSS size so iframe innerWidth matches the phone.
 * Visual size is size × scale. Negative margins let flex centering use the painted box.
 * CSS zoom is intentionally absent: a zoomed iframe keeps a full border box and paints only the top-left.
 */

export function deviceFrameStyle(width: number, height: number, scale: number): {
  width: string; height: string; transform: string; transformOrigin: "top left";
  marginRight: string; marginBottom: string; visualWidth: number; visualHeight: number;
} {
  const safe = Number.isFinite(scale) ? Math.min(1, Math.max(MIN_DEVICE_SCALE, scale)) : 1;
  const w = Math.round(width);
  const h = Math.round(height);
  return {
    width: `${w}px`,
    height: `${h}px`,
    transform: `scale(${safe})`,
    transformOrigin: "top left",
    marginRight: `${Math.round(w * (safe - 1))}px`,
    marginBottom: `${Math.round(h * (safe - 1))}px`,
    visualWidth: Math.round(w * safe),
    visualHeight: Math.round(h * safe),
  };
}

/** Explicit CSS px. device-width plus a spoofed iPhone UA can resolve against the wrong screen. */
export function deviceViewportMeta(width: number): string {
  const px = Math.min(4000, Math.max(200, Math.round(width)));
  return `width=${px}, initial-scale=1, minimum-scale=1, maximum-scale=1`;
}

export function viewportLabel(choice: ViewportChoice): string {
  if (choice.mode === "desktop") return t("viewport.desktop");
  if (choice.preset === "iphone") return "iPhone";
  if (choice.preset === "tablet") return t("viewport.tablet");
  return `${choice.width}×${choice.height}`;
}

/** Scale a device frame down so it stays centered inside the panel. 1 means the CSS viewport is exact. */
export function fitDevice(width: number, height: number, panelW: number, panelH: number, margin = 32): { scale: number } {
  if (!(width > 0) || !(height > 0) || panelW < 80 || panelH < 80) return { scale: 1 };
  const availW = panelW - margin * 2;
  const availH = panelH - margin * 2;
  if (availW <= 0 || availH <= 0) return { scale: 1 };
  const scale = Math.min(1, availW / width, availH / height);
  return { scale: Math.max(MIN_DEVICE_SCALE, Math.round(scale * 100) / 100) };
}
