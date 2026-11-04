import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, StewardMoveConfirm, workerTreeReducer } from "./Sidebar";
import type { Session } from "../server/types";

const noop = () => {};
const ok = async () => true;
const group = { id: "project-1", name: "앱 개발", createdAt: "2026-01-01", workspaceId: "personal" as const };
function session(id: string, groupId?: string, status: Session["status"] = "done"): Session {
  return { id, title: `채팅-${id}`, groupId, status, agent: "codex", workers: ["claude"], cwd: "/tmp", createdAt: "2026-01-01", events: [], workspaceId: "personal" };
}
function render(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return renderToStaticMarkup(createElement(Sidebar, {
    tab: "workspace", onNavigate: noop, onSkills: noop, connected: true,
    sessions: [], groups: [], busy: false, onNew: noop, onSelect: noop, onHelp: noop,
    onCreateGroup: ok, onRenameGroup: ok, onDeleteGroup: ok, onRenameSession: ok, onDeleteSession: ok, onAssign: ok,
    ...overrides,
  }));
}
test("sidebar nests project chats and keeps ungrouped and orphaned chats in recent", () => {
  const html = render({ groups: [group], sessions: [session("nested", group.id, "running"), session("recent"), session("orphan", "missing", "error")], selected: "nested" });
  const projects = html.slice(html.indexOf('aria-label="프로젝트"'), html.indexOf('aria-label="최근 채팅"'));
  const recents = html.slice(html.indexOf('aria-label="최근 채팅"'));
  assert.match(projects, /채팅-nested/);
  assert.doesNotMatch(projects, /채팅-recent|채팅-orphan/);
  assert.match(recents, /채팅-recent/);
  assert.match(recents, /채팅-orphan/);
  assert.doesNotMatch(recents, /채팅-nested/);
  assert.match(projects, /aria-current="page"/);
  assert.match(projects, /aria-expanded="true" aria-controls="project-project-1"/);
  assert.match(projects, /aria-label="진행 중"/);
  assert.match(recents, /aria-label="오류"/);
  assert.match(html, /data-draggable="true"/);
});
test("sidebar offers new chat, search, project creation and a single settings row", () => {
  const html = render();
  for (const label of ["새 채팅", "채팅 및 프로젝트 검색", "프로젝트 만들기"]) assert.ok(html.includes(`aria-label="${label}"`));
  // One settings row opens a menu (tools, bots, skills, usage, help, reload): no row of tiny icons.
  assert.match(html, /<button class="sidebar-settings" aria-haspopup="menu" aria-expanded="false"><svg[^>]*>[\s\S]*?<span>설정<\/span><\/button>/);
  assert.doesNotMatch(html, /sidebar-tools|aria-label="도구 관리"|aria-label="봇"|aria-label="스킬"/);
  assert.match(html, /<kbd aria-hidden="true">(?:⌘K|Ctrl\+K)<\/kbd>/);
  assert.doesNotMatch(html, /작업 그룹|에이전트 관리/);
  // The collapse toggle lives in the title bar now, not inside the sidebar.
  assert.doesNotMatch(html, /사이드바 접기|사이드바 펼치기/);
  assert.match(html, /<kbd aria-hidden="true">(?:⌘N|Ctrl\+N)<\/kbd>/);
  assert.match(html, /아직 채팅이 없습니다/);
  assert.match(html, /프로젝트로 채팅을 모아 보세요/);
});
test("sidebar keeps the workspace switcher exclusively in the header", () => {
  const html = render({ workspaceId: "company" });
  assert.doesNotMatch(html, /workspace-switcher/);
});
test("a closed sidebar is inert and busy chats cannot be dragged", () => {
  const companySession = { ...session("busy"), workspaceId: "company" as const };
  const html = render({ id: "app-sidebar", closed: true, busy: true, sessions: [companySession], workspaceId: "company" });
  assert.match(html, /<aside id="app-sidebar" class="rail" aria-label="사이드바" inert="">/);
  assert.match(html, /data-draggable="false"/);
  assert.doesNotMatch(render({ id: "app-sidebar" }), /inert/);
});

test("project rows offer a hover new-chat button next to the menu", () => {
  const html = render({ groups: [group], sessions: [session("nested", group.id)] });
  assert.match(html, /aria-label="앱 개발에서 새 채팅"/);
  assert.match(html, /role="status"[^>]*>[\s\S]*연결됨/);
});

test("moving a project lead shows a workspace picker and explicit confirmation", () => {
  const html = renderToStaticMarkup(createElement(StewardMoveConfirm, {
    name: "API 담당",
    target: "company",
    workspaces: [{ id: "personal", name: "개인" }, { id: "company", name: "회사" }],
    busy: false,
    onTarget: noop,
    onCancel: noop,
    onConfirm: noop,
  }));
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /API 담당.*다른 공간으로 이동/);
  assert.match(html, /<select[^>]*aria-label="이동할 공간"/);
  assert.match(html, /<option value="company" selected="">회사<\/option>/);
  assert.match(html, />이동 확인<\/button>/);
  assert.match(html, /이 담당의 모든 채팅도 함께 이동합니다/);
});

test("a lead without chats still exposes its actions menu", () => {
  const html = render({
    stewards: [{ id: "lead-1", workspaceId: "personal", name: "문서", cwds: ["/tmp"], systemPrompt: "", skills: [], agent: "codex", workers: [], mergePolicy: "ask", createdAt: "2026-01-01" }],
    onNewStewardThread: noop,
    onMoveSteward: ok,
  });
  assert.match(html, /aria-label="문서 메뉴"/);
  assert.match(html, /aria-haspopup="menu"/);
});

test("active conversation expands one sidebar child per worker with task count and live status", () => {
  const chat = session("tree", group.id, "running");
  chat.events = [
    { id: "task-a", sessionId: chat.id, type: "delegation", agent: "claude", role: "worker", model: "claude-sonnet-4-6", text: "코드 검토", time: "2026-10-30T00:00:00Z", taskStatus: "running", delegationId: "task-a" },
    { id: "task-b", sessionId: chat.id, type: "delegation", agent: "claude", role: "worker", model: "claude-opus-4-6", text: "테스트 검토", time: "2026-10-30T00:00:01Z", taskStatus: "running", delegationId: "task-b" },
    { id: "done", sessionId: chat.id, type: "status", agent: "claude", role: "worker", text: "완료", time: "2026-10-30T00:00:02Z", taskStatus: "done", delegationId: "task-a" },
  ];
  const html = render({ sessions: [chat], groups: [group], selected: chat.id, selectedWorker: "claude", onSelectWorker: noop });
  assert.match(html, /aria-expanded="true" aria-controls="workers-tree"/);
  assert.match(html, /<ul class="sidebar-workers" id="workers-tree" aria-label="채팅-tree 작업 세션">/);
  assert.match(html, /id="sidebar-worker-tree-claude" class="sidebar-worker active" aria-current="page"/);
  assert.equal((html.match(/id="sidebar-worker-/g) ?? []).length, 1);
  assert.match(html, /Claude/);
  assert.match(html, /작업 2개/);
  assert.match(html, /claude-opus-4-6/);
  assert.match(html, /assets\/agents\/claude-color.svg/);
  assert.match(html, /status-beat" role="img" aria-label="진행 중"><span class="beat" aria-hidden="true">/);
  assert.doesNotMatch(html, /status-dot running/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  const parent = render({ sessions: [chat], selected: chat.id });
  assert.match(parent, /sidebar-chat-open active" aria-current="page"/);
  assert.doesNotMatch(parent, /sidebar-worker active/);
});

test("running orchestrator-only chat explains that no worker session is expected", () => {
  const chat = session("solo", undefined, "running");
  const html = render({ sessions: [chat], selected: chat.id });
  assert.match(html, /오케스트라가 직접 처리 중/);
  assert.doesNotMatch(html, /아직 작업 세션이 없습니다/);
});

test("inactive conversation workers are initially collapsed and failed tasks expose an error label", () => {
  const chat = session("inactive");
  chat.events = [
    { id: "task", sessionId: chat.id, type: "delegation", agent: "grok", text: "조사", time: "2026-10-30T00:00:00Z" },
    { id: "failed", sessionId: chat.id, type: "error", agent: "grok", delegationId: "task", taskStatus: "error", text: "실패", time: "2026-10-30T00:00:01Z" },
  ];
  const html = render({ sessions: [chat] });
  assert.match(html, /aria-expanded="false" aria-controls="workers-inactive"/);
  assert.match(html, /aria-label="채팅-inactive 작업 세션" hidden=""/);
  assert.match(html, /Grok Build/);
  assert.match(html, /작업 1개/);
  assert.match(html, /CLI 기본 모델/);
  assert.match(html, /status-dot error" role="img" aria-label="오류"/);
});


test("worker spawn reopens the active tree while ordinary log updates preserve manual collapse", () => {
  let state = workerTreeReducer({ expanded: new Set<string>() }, { type: "activate", id: "chat", taskKey: "[]" });
  assert.ok(state.expanded.has("chat"));
  state = workerTreeReducer(state, { type: "toggle", id: "chat" });
  assert.ok(!state.expanded.has("chat"));
  state = workerTreeReducer(state, { type: "activate", id: "chat", taskKey: "[]" });
  assert.ok(!state.expanded.has("chat"));
  state = workerTreeReducer(state, { type: "activate", id: "chat", taskKey: '["worker-a"]' });
  assert.ok(state.expanded.has("chat"));
  state = workerTreeReducer(state, { type: "toggle", id: "chat" });
  state = workerTreeReducer(state, { type: "activate", id: "chat", taskKey: '["worker-a"]', workerId: "worker-a" });
  assert.ok(state.expanded.has("chat"));
  state = workerTreeReducer(state, { type: "activate", id: "other", taskKey: "[]" });
  assert.ok(state.expanded.has("other"));
  assert.ok(state.expanded.has("chat"));
});

test("duplicate workers show distinct labels and select by worker id", () => {
  const chat = session("duplicates");
  chat.workers = ["codex", "codex"];
  chat.events = ["codex-1", "codex-2"].map((workerId, index) => ({ id: `task-${index}`, sessionId: chat.id, type: "delegation", agent: "codex", role: "worker", workerId, workerLabel: `Codex ${index + 1}`, text: "review", time: "2026-10-30T00:00:00Z" }));
  const html = render({ sessions: [chat], selected: chat.id, selectedWorker: "codex-2" });
  assert.match(html, /id="sidebar-worker-duplicates-codex-1"/);
  assert.match(html, /id="sidebar-worker-duplicates-codex-2" class="sidebar-worker active"/);
  assert.match(html, /Codex 1/);
  assert.match(html, /Codex 2/);
});
