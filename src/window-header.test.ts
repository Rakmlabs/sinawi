import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isTauri, WindowHeader } from "./WindowHeader";

test("header is absent outside Tauri and follows the selected conversation inside it", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const render = (title?: string) => renderToStaticMarkup(createElement(WindowHeader, { title }));
  try {
    Reflect.deleteProperty(globalThis, "window");
    assert.equal(isTauri(), false);
    assert.equal(render("Conversation"), "");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    assert.equal(render("Conversation"), "");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    assert.equal(isTauri(), true);
    assert.match(render(), /새 채팅/);
    const first = render("코드 검토");
    assert.match(first, /<svg class="sinawi-mark"[^>]*aria-hidden="true"/);
    assert.match(first, /<\/svg>Sinawi<\/span>/);
    assert.doesNotMatch(first, /Agent Orchestra/);
    assert.match(first, /코드 검토/);
    const button = first.match(/<button\b[^>]*>/)?.[0];
    assert.ok(button, "desktop header includes a reload button");
    assert.match(button, /aria-label="새로고침"/);
    assert.doesNotMatch(button, /data-tauri-drag-region/);
    // Bare drag regions only respond to direct hits, so every child needs one.
    const elements = first.match(/<(?:header|div|span)\b[^>]*>/g) ?? [];
    assert.equal(elements.length, 5);
    assert.ok(elements.every((element) => element.includes("data-tauri-drag-region")));
    const renamed = render("새 제목 <script>");
    assert.match(renamed, /새 제목 &lt;script&gt;/);
    assert.doesNotMatch(renamed, /코드 검토/);
    const workspace = renderToStaticMarkup(createElement(WindowHeader, { title: "코드 검토", workspaceId: "personal", onSwitchWorkspace: () => {}, otherRunning: 1 }));
    assert.match(workspace, /aria-label="개인 작업 공간, 회사로 전환"/);
    assert.match(workspace, /회사에서 진행 중인 작업 1개/);
    const tools = renderToStaticMarkup(createElement(WindowHeader, { title: "코드 검토", onTools: () => {}, toolsActive: true }));
    assert.match(tools, /aria-label="도구 관리"/);
    assert.match(tools, /aria-current="page"/);
    assert.match(tools, /도구 관리 \(⌘⇧T · F3\)/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("desktop capability permits dragging and maximizing while retaining the overlay title bar", () => {
  const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const capability = read("../src-tauri/capabilities/default.json");
  for (const permission of ["core:default", "core:window:allow-start-dragging", "core:window:allow-toggle-maximize"]) {
    assert.ok(capability.permissions.includes(permission));
  }
  const config = read("../src-tauri/tauri.conf.json");
  assert.equal(config.app.windows[0].titleBarStyle, "Overlay");
  assert.equal(config.app.windows[0].hiddenTitle, true);
  assert.equal(config.app.windows[0].backgroundThrottling, "disabled");
});
