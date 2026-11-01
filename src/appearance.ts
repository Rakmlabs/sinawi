// Appearance preferences (theme, language, fonts, size). Shared contract with the CSS:
// <html data-theme="dark|light"> (absent = system), --font-ui / --font-mono / --font-scale on <html>,
// and <html lang>. Only values the user changed are set; the stylesheet supplies the defaults.
import { useSyncExternalStore } from "react";
import { readPreference, writePreference } from "./preferences";
import { setLang, type Lang } from "./i18n";

export type ThemePref = "system" | "dark" | "light";
export type FontSize = "small" | "normal" | "large";
/** "default" (Pretendard / JetBrains Mono stacks from CSS), "system", or a custom font-family name. */
export type FontPref = string;
export type Appearance = { theme: ThemePref; lang: Lang; uiFont: FontPref; monoFont: FontPref; fontSize: FontSize };

const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", system-ui, sans-serif';
const SYSTEM_MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";
const DEFAULT_UI = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
const DEFAULT_MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SCALE: Record<FontSize, number> = { small: 0.9, normal: 1, large: 1.1 };

export function defaultLang(language = typeof navigator === "undefined" ? "" : navigator.language): Lang {
  return /^ko\b/i.test(language ?? "") ? "ko" : "en";
}

/** Strips characters that could break out of a CSS font-family value. */
export function cleanFontName(name: string): string {
  return name.replace(/["'`;{}()<>\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function fontStack(pref: FontPref, kind: "ui" | "mono"): string | undefined {
  if (!pref || pref === "default") return undefined;
  if (pref === "system") return kind === "ui" ? SYSTEM_UI : SYSTEM_MONO;
  const name = cleanFontName(pref);
  return name ? `"${name}", ${kind === "ui" ? DEFAULT_UI : DEFAULT_MONO}` : undefined;
}

export function readAppearance(read: (key: string) => string | null = readPreference): Appearance {
  const theme = read("theme");
  const lang = read("lang");
  const size = read("fontSize");
  return {
    theme: theme === "dark" || theme === "light" ? theme : "system",
    lang: lang === "ko" || lang === "en" ? lang : defaultLang(),
    uiFont: read("uiFont") || "default",
    monoFont: read("monoFont") || "default",
    fontSize: size === "small" || size === "large" ? size : "normal",
  };
}

export function applyAppearance(value: Appearance, root: HTMLElement = document.documentElement) {
  if (value.theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = value.theme;
  const set = (name: string, css: string | undefined) => css ? root.style.setProperty(name, css) : root.style.removeProperty(name);
  set("--font-ui", fontStack(value.uiFont, "ui"));
  set("--font-mono", fontStack(value.monoFont, "mono"));
  set("--font-scale", value.fontSize === "normal" ? undefined : String(SCALE[value.fontSize]));
  root.lang = value.lang;
  setLang(value.lang);
}

let current: Appearance | undefined;
const listeners = new Set<() => void>();
const snapshot = () => current ??= readAppearance();

/** Reads saved preferences and applies them; call before the first render to avoid a flash. */
export function initAppearance() {
  current = readAppearance();
  applyAppearance(current);
}

export function updateAppearance(patch: Partial<Appearance>) {
  current = { ...snapshot(), ...patch };
  for (const [key, value] of Object.entries(patch)) writePreference(key, String(value));
  applyAppearance(current);
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot, snapshot);
}
