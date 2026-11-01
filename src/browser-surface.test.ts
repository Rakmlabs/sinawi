import test from "node:test";
import assert from "node:assert/strict";
import { pushRecent } from "./browser-surface";

test("recent sites dedupe and cap", () => {
  let list = pushRecent([], "http://localhost:3000/", "앱", 1);
  list = pushRecent(list, "http://localhost:5173", "", 2);
  list = pushRecent(list, "http://localhost:3000", "앱2", 3);
  assert.deepEqual(list.map((item) => item.url), ["http://localhost:3000", "http://localhost:5173"]);
  assert.equal(pushRecent(list, "about:blank", "", 4), list);
  for (let i = 0; i < 20; i++) list = pushRecent(list, `http://localhost:${4000 + i}/`, "", i);
  assert.equal(list.length, 8);
});

test("⌥⌘I opens developer tools from the browser", async () => {
  const { browserShortcut } = await import("./browser-shortcuts");
  assert.deepEqual(browserShortcut({ key: "ˆ", code: "KeyI", metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }), { type: "devtools" });
});

test("⌃⌥ arrows snap the browser window and avoid macOS ⌘⌥ arrows", async () => {
  const { windowShortcut } = await import("./browser-shortcuts");
  const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key, code: key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.deepEqual(windowShortcut(k("ArrowLeft", { ctrlKey: true, altKey: true })), { type: "snap", snap: "left" });
  assert.deepEqual(windowShortcut(k("ArrowRight", { ctrlKey: true, altKey: true })), { type: "snap", snap: "right" });
  assert.deepEqual(windowShortcut(k("ArrowUp", { ctrlKey: true, altKey: true })), { type: "snap", snap: "max" });
  assert.equal(windowShortcut(k("ArrowLeft", { metaKey: true, altKey: true })), undefined);
  assert.equal(windowShortcut(k("ArrowLeft", { ctrlKey: true })), undefined);
});

test("⌘W closes the browser tab and ⌘⇧J toggles the chat pane", async () => {
  const { browserShortcut, chatShortcut } = await import("./browser-shortcuts");
  assert.deepEqual(browserShortcut({ key: "w", code: "KeyW", metaKey: true, altKey: false, ctrlKey: false, shiftKey: false }), { type: "close-tab" });
  assert.ok(chatShortcut({ key: "J", code: "KeyJ", metaKey: true, altKey: false, ctrlKey: false, shiftKey: true }));
  assert.ok(!chatShortcut({ key: "j", code: "KeyJ", metaKey: true, altKey: false, ctrlKey: false, shiftKey: false }));
});
