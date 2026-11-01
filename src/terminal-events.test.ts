import test from "node:test";
import assert from "node:assert/strict";
import {
  installTerminalShortcuts,
  openTerminal,
  TERMINAL_OPEN_EVENT,
  TERMINAL_TOGGLE_EVENT,
  terminalOwnsKeyboardEvent,
  toggleTerminal,
} from "./terminal-events";

function keyboard(target: EventTarget, overrides: Record<string, unknown> = {}) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, {
    key: "`",
    code: "Backquote",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
  }, overrides);
  target.dispatchEvent(event);
  return event;
}

test("openTerminal dispatches an app-level request with cwd and command", () => {
  const target = new EventTarget();
  let detail: unknown;
  target.addEventListener(TERMINAL_OPEN_EVENT, (event) => {
    detail = (event as CustomEvent).detail;
  });

  openTerminal({ cwd: "/tmp/project", command: "grok" }, target);

  assert.deepEqual(detail, { cwd: "/tmp/project", command: "grok" });
});

test("toggleTerminal dispatches a separate toggle request", () => {
  const target = new EventTarget();
  let calls = 0;
  target.addEventListener(TERMINAL_TOGGLE_EVENT, () => { calls++; });
  toggleTerminal(target);
  assert.equal(calls, 1);
});

test("terminal shortcuts toggle and create tabs without handling unrelated keys", () => {
  const target = new EventTarget();
  const calls: string[] = [];
  const dispose = installTerminalShortcuts(target, {
    toggle: () => calls.push("toggle"),
    newTab: () => calls.push("new"),
  });

  assert.equal(keyboard(target).defaultPrevented, true);
  assert.equal(keyboard(target, { shiftKey: true }).defaultPrevented, true);
  assert.equal(keyboard(target, { key: "x", code: "KeyX" }).defaultPrevented, false);
  assert.equal(keyboard(target, { metaKey: true }).defaultPrevented, false);
  assert.deepEqual(calls, ["toggle", "new"]);

  dispose();
  assert.equal(keyboard(target).defaultPrevented, false);
});

test("terminal keyboard ownership recognizes xterm descendants", () => {
  const terminal = { closest: (selector: string) => selector === ".terminal-panel" ? {} : null };
  const outside = { closest: () => null };
  assert.equal(terminalOwnsKeyboardEvent({ target: terminal } as unknown as KeyboardEvent), true);
  assert.equal(terminalOwnsKeyboardEvent({ target: outside } as unknown as KeyboardEvent), false);
  assert.equal(terminalOwnsKeyboardEvent({ target: null } as unknown as KeyboardEvent), false);
});

test("Ctrl+` toggles once per physical press (keyup/repeat ignored)", async () => {
  const { consumeTerminalShortcut, terminalShortcut } = await import("./terminal-events");
  let toggles = 0;
  const actions = { toggle: () => { toggles++; }, newTab: () => {} };
  const ev = (type: string, extra: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), {
    key: "`", code: "Backquote", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, ...extra,
  }) as unknown as KeyboardEvent;
  consumeTerminalShortcut(ev("keydown"), actions);
  consumeTerminalShortcut(ev("keydown", { repeat: true }), actions);
  consumeTerminalShortcut(ev("keypress"), actions);
  const up = ev("keyup");
  assert.equal(consumeTerminalShortcut(up, actions), true);
  assert.equal(up.defaultPrevented, true);
  assert.equal(toggles, 1);
  assert.equal(terminalShortcut(ev("keyup")), undefined);
  consumeTerminalShortcut(ev("keydown"), actions);
  assert.equal(toggles, 2);
});
