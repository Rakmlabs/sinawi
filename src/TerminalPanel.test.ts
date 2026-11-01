import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveModuleConstructor, restoreTerminalState, TerminalPanel } from "./TerminalPanel";

test("terminal panel renders persistent bottom-panel controls while hidden", () => {
  const html = renderToStaticMarkup(createElement(TerminalPanel, { cwd: "/tmp/project" }));
  assert.match(html, /class="terminal-panel"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /새 터미널/);
  assert.match(html, /외부 터미널에서 열기/);
  assert.match(html, /터미널 패널 닫기/);
});

test("saved live tabs retain their reconnect id while exited tabs get a fresh id", () => {
  let ids = 0;
  const state = restoreTerminalState(JSON.stringify({
    activeId: "old-exited",
    tabs: [
      { id: "live", cwd: "/tmp/live" },
      { id: "old-exited", cwd: "/tmp/exited", exited: true },
    ],
  }), () => `fresh-${++ids}`);

  assert.deepEqual(state.tabs, [
    { id: "live", cwd: "/tmp/live", exited: false },
    { id: "fresh-1", cwd: "/tmp/exited", exited: false },
  ]);
  assert.equal(state.activeId, "fresh-1");
});

test("invalid terminal state is ignored", () => {
  assert.deepEqual(restoreTerminalState("not json"), { tabs: [], activeId: undefined });
  assert.deepEqual(restoreTerminalState(JSON.stringify({ tabs: [{ id: "", cwd: 4 }] })), { tabs: [], activeId: undefined });
});

test("xterm constructors resolve from Vite ESM and CommonJS default shapes", () => {
  class Addon {}
  assert.equal(resolveModuleConstructor({ Addon }, "Addon"), Addon);
  assert.equal(resolveModuleConstructor({ default: { Addon } }, "Addon"), Addon);
  assert.equal(resolveModuleConstructor({ default: Addon }, "Addon"), Addon);
  assert.throws(() => resolveModuleConstructor({}, "Addon"), /Addon 모듈/);
});
