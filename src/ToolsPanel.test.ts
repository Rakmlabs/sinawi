import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsPanel, createRequestGate, filterTools, toolStatusPresentation, toolUpdateRequest, toolsListPath, toolsShortcut, type ToolsState } from "./ToolsPanel";

const state: ToolsState = {
  mcp: [
    { agent: "codex", name: "bbanana", command: "bbanana", nativeEnabled: true, appEnabled: false, status: "disabled", forcedOff: true, reason: "회사 공간에서는 사용할 수 없습니다." },
    { agent: "grok", name: "search", url: "https://example.test/mcp", nativeEnabled: true, appEnabled: true, status: "enabled" },
    { agent: "claude", name: "browser", command: "claude-browser", nativeEnabled: true, appEnabled: true, status: "enabled" },
  ],
  skills: [
    { name: "frontend-design", source: "Agents", agents: ["codex"], description: "프런트엔드 디자인 지침", enabled: true },
    { name: "review", source: "프로젝트", agents: ["claude", "grok"], description: "코드 검토", enabled: false },
  ],
};

test("tools panel renders MCP rows with real agent marks, statuses and locked company policy", () => {
  const html = renderToStaticMarkup(createElement(ToolsPanel, { workspaceId: "company", cwd: "/company/app", initialState: state }));
  assert.match(html, /<h1 id="tools-heading">도구 관리<\/h1>/);
  assert.match(html, /aria-label="도구 검색"/);
  assert.match(html, /role="tab" aria-selected="true"/);
  assert.match(html, /Codex/);
  assert.match(html, /assets\/agents\/codex.svg/);
  assert.match(html, /bbanana/);
  assert.match(html, /잠김/);
  assert.match(html, /회사 공간에서는 사용할 수 없습니다/);
  assert.match(html, /role="switch"[^>]*disabled=""/);
});

test("skill mode groups searchable rows by source and shows all attached agents", () => {
  const html = renderToStaticMarkup(createElement(ToolsPanel, { workspaceId: "personal", cwd: "/personal/app", initialState: state, initialTab: "skills" }));
  assert.match(html, /role="tab" aria-selected="true"[\s\S]*?스킬<\/button>/);
  assert.match(html, /프로젝트/);
  assert.match(html, /코드 검토/);
  assert.match(html, /Claude/);
  assert.match(html, /Grok Build/);
  assert.match(html, /role="switch"/);
  assert.deepEqual(filterTools(state.skills, "프런트"), [state.skills[0]]);
  assert.deepEqual(filterTools(state.skills, "없는 도구"), []);
});

test("tool shortcuts accept Cmd/Ctrl+Shift+T and unmodified F3 while preserving composition", () => {
  const event = (overrides: Partial<KeyboardEvent>) => ({ key: "t", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, isComposing: false, keyCode: 0, ...overrides }) as KeyboardEvent;
  assert.equal(toolsShortcut(event({})), true);
  assert.equal(toolsShortcut(event({ metaKey: false, ctrlKey: true })), true);
  assert.equal(toolsShortcut(event({ key: "F3", metaKey: false, shiftKey: false })), true);
  assert.equal(toolsShortcut(event({ isComposing: true })), false);
  assert.equal(toolsShortcut(event({ keyCode: 229 })), false);
  assert.equal(toolsShortcut(event({ key: "F3", shiftKey: true, metaKey: false })), false);
});

test("tool updates use the workspace-aware PUT contract", () => {
  assert.deepEqual(toolUpdateRequest("company", "/company/app", "mcp", "bbanana", false, "codex"), {
    path: "/api/tools/mcp",
    init: { method: "PUT", body: JSON.stringify({ name: "bbanana", enabled: false, workspace: "company", cwd: "/company/app", agent: "codex" }) },
  });
  assert.deepEqual(toolUpdateRequest("personal", "/personal/app", "skill", "review", true), {
    path: "/api/tools/skill",
    init: { method: "PUT", body: JSON.stringify({ name: "review", enabled: true, workspace: "personal", cwd: "/personal/app" }) },
  });
  assert.equal(toolsListPath("company", "/회사 작업/app"), "/api/tools?workspace=company&cwd=%2F%ED%9A%8C%EC%82%AC%20%EC%9E%91%EC%97%85%2Fapp");
});

test("request generations reject stale completions", () => {
  const gate = createRequestGate();
  const initialLoad = gate.begin();
  const mutation = gate.begin();
  assert.equal(gate.isCurrent(initialLoad), false);
  assert.equal(gate.isCurrent(mutation), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(mutation), false);
});

test("Claude MCP rows explain native read-only and app-level control", () => {
  const html = renderToStaticMarkup(createElement(ToolsPanel, { workspaceId: "personal", cwd: "/personal/app", initialState: state }));
  assert.match(html, /Claude MCP는 앱에서만 켜고 끕니다/);
  assert.match(html, /앱에서 관리/);
});

test("Claude status presentation retains native connection and app enablement", () => {
  assert.deepEqual(toolStatusPresentation({ ...state.mcp[2], status: "connected" }), { label: "연결됨 · 앱에서 관리", tone: "enabled" });
  assert.deepEqual(toolStatusPresentation({ ...state.mcp[2], status: "disconnected", nativeEnabled: false }), { label: "연결 안 됨 · 앱에서 관리", tone: "error" });
  assert.deepEqual(toolStatusPresentation({ ...state.mcp[2], status: "app-disabled", appEnabled: false }), { label: "앱에서 사용 안 함", tone: "disabled" });
});
