import test from "node:test";
import assert from "node:assert/strict";
import { installAppReload, reloadApp } from "./reload";

function desktop() {
  const target = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    location: { reload: () => { reloads++; } },
  });
  let reloads = 0;
  return { target: target as unknown as Window, count: () => reloads };
}

function key(target: Window, overrides: Record<string, unknown> = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "r", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }, overrides);
  target.dispatchEvent(event);
  return event;
}

test("Cmd+R and Cmd+Shift+R reload the page and consume the native shortcut", () => {
  const { target, count } = desktop();
  const dispose = installAppReload(target);
  assert.equal(key(target).defaultPrevented, true);
  assert.equal(key(target, { key: "R", shiftKey: true }).defaultPrevented, true);
  assert.equal(count(), 2);
  dispose();
  assert.equal(key(target).defaultPrevented, false);
  assert.equal(count(), 2);
});

test("reload shortcut ignores typing, other modifiers, composition and key repeats", () => {
  const { target, count } = desktop();
  const dispose = installAppReload(target);
  for (const overrides of [{ metaKey: false }, { key: "b" }, { altKey: true }, { ctrlKey: true }, { repeat: true }, { isComposing: true }]) {
    assert.equal(key(target, overrides).defaultPrevented, false);
  }
  assert.equal(count(), 0);
  dispose();
});

test("ordinary browser shortcuts remain untouched", () => {
  const { target, count } = desktop();
  Reflect.deleteProperty(target, "__TAURI_INTERNALS__");
  const dispose = installAppReload(target);
  assert.equal(key(target).defaultPrevented, false);
  assert.equal(count(), 0);
  dispose();
});

test("explicit reload uses page navigation only", () => {
  const { target, count } = desktop();
  reloadApp(target);
  assert.equal(count(), 1);
});

test("terminal owns Cmd+R even in the capture phase", () => {
  const { target, count } = desktop();
  Object.assign(target, { closest: (selector: string) => selector === ".terminal-panel" ? {} : null });
  const dispose = installAppReload(target);
  assert.equal(key(target).defaultPrevented, false);
  assert.equal(count(), 0);
  dispose();
});
