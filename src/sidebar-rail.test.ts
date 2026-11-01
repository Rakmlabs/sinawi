import test from "node:test";
import assert from "node:assert/strict";
import { railToggleLabel, sidebarLayout, sidebarShortcut } from "./sidebar-rail";

test("a wide window docks the sidebar and follows the saved preference", () => {
  assert.deepEqual(sidebarLayout({ collapsed: false, narrow: false, focusMode: false, overlayOpen: false }), { overlay: false, open: true });
  assert.deepEqual(sidebarLayout({ collapsed: true, narrow: false, focusMode: false, overlayOpen: true }), { overlay: false, open: false });
});

test("narrow windows and browser focus overlay the sidebar and ignore the saved preference", () => {
  assert.deepEqual(sidebarLayout({ collapsed: false, narrow: true, focusMode: false, overlayOpen: false }), { overlay: true, open: false });
  assert.deepEqual(sidebarLayout({ collapsed: true, narrow: false, focusMode: true, overlayOpen: true }), { overlay: true, open: true });
});

test("the sidebar shortcut is ⌘B / ⌘\\ on macOS and Ctrl elsewhere, never with Shift or Alt", () => {
  const key = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(sidebarShortcut(key("b", { metaKey: true }), true), true);
  assert.equal(sidebarShortcut(key("\\", { metaKey: true }), true), true);
  assert.equal(sidebarShortcut(key("b", { ctrlKey: true }), true), false);
  assert.equal(sidebarShortcut(key("B", { metaKey: true, shiftKey: true }), true), false);
  assert.equal(sidebarShortcut(key("b", { ctrlKey: true }), false), true);
  assert.equal(sidebarShortcut(key("\\", { ctrlKey: true }), false), true);
  assert.equal(sidebarShortcut(key("b", { metaKey: true }), false), false);
  assert.equal(sidebarShortcut(key("b", { ctrlKey: true, altKey: true }), false), false);
});

test("sidebar labels follow the collapsed state", () => {
  assert.equal(railToggleLabel(true), "사이드바 펼치기");
  assert.equal(railToggleLabel(false), "사이드바 접기");
});
