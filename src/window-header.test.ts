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
    // Reload lives on ⌘R and in the sidebar settings menu, not in the title bar.
    assert.doesNotMatch(first, /aria-label="새로고침"/);
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
    // Right side: workspace slot, terminal, browser, notifications, activity — no tools/settings duplicates.
    const right = render({ title: "코드 검토", sidebar, workspace: createElement("span", { className: "ws-slot" }), onTerminal: () => {}, onBrowser: () => {},
      activity: { open: true, controls: "activity-panel", onToggle: () => {} } });
    assert.match(right, /ws-slot/);
    assert.match(right, /aria-label="통합 터미널"/);
    assert.match(right, /aria-label="브라우저"|aria-label="[^"]*브라우저[^"]*"/);
    assert.match(right, /aria-label="실시간 활동"[^>]*aria-expanded="true" aria-controls="activity-panel"/);
    assert.doesNotMatch(right, /aria-label="도구 관리"|aria-label="설정"/);
    const icons = right.match(/class="header-icon-button[^"]*"/g) ?? [];
    assert.equal(icons.length, 4, "sidebar toggle + terminal + browser + activity");
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
  // tao insets the lights by growing the title-bar container to (button height + y) with the buttons
  // keeping their bottom offset, so y = 25 centres them on y = 24 of the 48px header (the old y = 17
  // measured 8px high). Lights span x 16 → ~70; the 74px spacer + 8px gap starts the toggle at 82.
  assert.deepEqual(config.app.windows[0].trafficLightPosition, { x: 16, y: 25 });
  const css = readFileSync(new URL("./window-header.css", import.meta.url), "utf8");
  assert.match(css, /\.window-header-traffic \{\s*flex: 0 0 74px;/);
  assert.match(readFileSync(new URL("./chat-layout.css", import.meta.url), "utf8"), /--window-header-height: 48px;/);
  assert.equal(config.app.windows[0].backgroundThrottling, "disabled");
});
