import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isTauri, WindowHeader } from "./WindowHeader";

test("title bar: traffic-light gap only in Tauri, sidebar toggle first, breadcrumb, drag regions", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const render = (props: Parameters<typeof WindowHeader>[0] = {}) => renderToStaticMarkup(createElement(WindowHeader, props));
  const sidebar = { open: true, controls: "app-sidebar", onToggle: () => {} };
  try {
    Reflect.deleteProperty(globalThis, "window");
    assert.equal(isTauri(), false);
    assert.equal(render({ title: "Conversation" }), "");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    assert.equal(render({ title: "Conversation" }), "");
    // A plain browser still gets the title bar and the toggle, but no traffic-light spacer.
    const browser = render({ title: "Conversation", sidebar });
    assert.match(browser, /aria-label="사이드바 접기"/);
    assert.doesNotMatch(browser, /window-header-traffic/);

    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    assert.equal(isTauri(), true);
    assert.match(render(), /새 채팅/);
    const first = render({ title: "코드 검토", project: "agent-orchestra", sidebar });
    assert.match(first, /<svg class="sinawi-mark"[^>]*aria-hidden="true"/);
    assert.match(first, /<\/svg>Sinawi<\/span>/);
    assert.doesNotMatch(first, /Agent Orchestra/);
    assert.match(first, /agent-orchestra<\/span>/);
    assert.match(first, /코드 검토/);
    // Spacer for the traffic lights, then the sidebar toggle, then the breadcrumb.
    assert.ok(first.indexOf("window-header-traffic") < first.indexOf("window-header-sidebar"));
    assert.ok(first.indexOf("window-header-sidebar") < first.indexOf("window-header-crumbs"));
    const toggle = first.match(/<button\b[^>]*window-header-sidebar[^>]*>/)?.[0];
    assert.ok(toggle, "header includes the sidebar toggle");
    assert.match(toggle, /aria-expanded="true"/);
    assert.match(toggle, /aria-controls="app-sidebar"/);
    assert.match(render({ sidebar: { ...sidebar, open: false } }), /aria-label="사이드바 펼치기"[^>]*aria-expanded="false"/);
    const reload = first.match(/<button\b[^>]*aria-label="새로고침"[^>]*>/)?.[0];
    assert.ok(reload, "desktop header includes a reload button");
    // Interactive controls stay clickable; everything else drags the window. Bare drag regions only
    // respond to direct hits, so every non-interactive element needs one.
    const buttons = first.match(/<button\b[^>]*>/g) ?? [];
    assert.ok(buttons.every((button) => !button.includes("data-tauri-drag-region")));
    const elements = first.match(/<(?:header|div|span)\b[^>]*>/g) ?? [];
    assert.ok(elements.length >= 8);
    assert.ok(elements.every((element) => element.includes("data-tauri-drag-region")));
    assert.doesNotMatch(first, /position:\s*absolute/);
    const running = render({ title: "코드 검토", runningSince: new Date(Date.now() - 65_000).toISOString() });
    assert.match(running, /class="window-header-status"[^>]*><span class="beat"[\s\S]*진행 중 · <time>1:0[45]<\/time>/);
    const renamed = render({ title: "새 제목 <script>" });
    assert.match(renamed, /새 제목 &lt;script&gt;/);
    assert.doesNotMatch(renamed, /코드 검토/);
    const workspace = render({ title: "코드 검토", workspaceId: "personal", onSwitchWorkspace: () => {}, otherRunning: 1 });
    assert.match(workspace, /aria-label="개인 작업 공간, 회사로 전환"/);
    assert.match(workspace, /회사에서 진행 중인 작업 1개/);
    const tools = render({ title: "코드 검토", onTools: () => {}, toolsActive: true, onSettings: () => {} });
    assert.match(tools, /aria-label="도구 관리"/);
    assert.match(tools, /aria-current="page"/);
    assert.match(tools, /도구 관리 \(⌘⇧T · F3\)/);
    assert.match(tools, /aria-label="설정"/);
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
  // Traffic lights centred in the 48px title bar, inside the 78px spacer the header reserves.
  assert.deepEqual(config.app.windows[0].trafficLightPosition, { x: 16, y: 17 });
  assert.equal(config.app.windows[0].backgroundThrottling, "disabled");
});
