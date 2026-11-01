export type BrowserAction =
  | { type: "new-tab" } | { type: "close-tab" } | { type: "reopen-tab" } | { type: "focus-url" } | { type: "reload" }
  | { type: "next-tab" } | { type: "prev-tab" } | { type: "select-tab"; index: number } | { type: "back" } | { type: "forward" }
  | { type: "toggle-picker" } | { type: "toggle-panel" } | { type: "toggle-terminal" } | { type: "devtools" } | { type: "snap"; snap: "left" | "right" | "max" };

type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** Shortcuts that only apply while the in-app browser has focus. */
export function browserShortcut(e: KeyLike): BrowserAction | undefined {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") return e.shiftKey ? { type: "prev-tab" } : { type: "next-tab" };
  if (e.metaKey && e.altKey && !e.ctrlKey && (e.code === "KeyI" || key === "i" || key === "ˆ")) return { type: "devtools" };
  if (!e.metaKey || e.ctrlKey || e.altKey) return undefined;
  if (e.shiftKey) {
    if (key === "t") return { type: "reopen-tab" };
    return undefined;
  }
  if (key === "t") return { type: "new-tab" };
  if (key === "w") return { type: "close-tab" };
  if (key === "l") return { type: "focus-url" };
  if (key === "r") return { type: "reload" };
  if (key === "[") return { type: "back" };
  if (key === "]") return { type: "forward" };
  if (/^[1-9]$/.test(key)) return { type: "select-tab", index: Number(key) === 9 ? -1 : Number(key) - 1 };
  return undefined;
}

/** Shortcuts that work anywhere in the app. */
export function globalBrowserShortcut(e: KeyLike): BrowserAction | undefined {
  if (!e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return undefined;
  const key = e.key.toLowerCase();
  if (key === "b" || e.code === "KeyB") return { type: "toggle-panel" };
  if (key === "c" || e.code === "KeyC") return { type: "toggle-picker" };
  return undefined;
}

export function browserOwnsFocus(doc: Pick<Document, "activeElement"> = document): boolean {
  const active = doc.activeElement as Element | null;
  return Boolean(active && typeof active.closest === "function" && active.closest(".browser-panel"));
}

/** Window snapping: ⌃⌥←/→ halves, ⌃⌥↑ maximize/restore (macOS uses ⌘⌥ arrows, so no clash). */
export function windowShortcut(e: KeyLike): BrowserAction | undefined {
  if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return undefined;
  if (e.key === "ArrowLeft") return { type: "snap", snap: "left" };
  if (e.key === "ArrowRight") return { type: "snap", snap: "right" };
  if (e.key === "ArrowUp") return { type: "snap", snap: "max" };
  return undefined;
}

/** ⌘⇧J folds/unfolds the chat pane. */
export function chatShortcut(e: KeyLike): boolean {
  return e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === "KeyJ" || e.key.toLowerCase() === "j");
}
