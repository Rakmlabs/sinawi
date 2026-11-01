import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceSettings } from "./app/WorkspaceSettings";
import { ComputerUseWorkspaceRows } from "./ComputerUse";
import { WorkspacesContext, type WorkspacesApi } from "./workspace-context";
import { defaultWorkspacePolicy, isWorkspacePolicyMessage, mediaBlockedMessage } from "../server/workspace-policy";

const noop = async () => true;
const api: WorkspacesApi = {
  workspaces: [{ id: "default", name: "기본" }, { id: "team", name: "Team" }],
  currentId: "default",
  defaults: { default: {}, team: { allowedAgents: ["claude"] } },
  settings: { default: defaultWorkspacePolicy(), team: { ...defaultWorkspacePolicy(), mediaGeneration: false, computerUse: true, blockedTools: ["image-tool", "grok:search"] } },
  running: {},
  switchTo: () => {}, create: noop, rename: noop, remove: noop, saveDefaults: noop, saveSettings: noop,
};

test("workspace settings render every rule per workspace with its current value", () => {
  const html = renderToStaticMarkup(createElement(WorkspacesContext.Provider, { value: api },
    createElement(WorkspaceSettings, { currentId: "default", busy: false, cwd: "/project", onPickFolder: () => {} })));
  for (const id of ["default", "team"]) {
    for (const rule of ["media", "computer", "grok-mcp", "blocked", "alerts"]) assert.match(html, new RegExp(`ws-${id}-${rule}`), `${id} ${rule}`);
  }
  // The open workspace's rules start expanded; the restricted one shows its summary.
  assert.match(html, /<details class="workspace-rules" open="">/);
  assert.match(html, /3개 제한/);
  assert.match(html, /image-tool/);
  assert.match(html, /search · Grok Build/);
  assert.match(html, /id="ws-team-computer"[^>]*checked=""/);
  assert.doesNotMatch(html, /id="ws-default-computer"[^>]*checked=""/);
  // Settings › Environment links to the open workspace's computer-use switch.
  assert.match(html, /data-setting-id="ws-computer"[^]*id="ws-default-computer"/);
  assert.equal(html.match(/data-setting-id="ws-computer"/g)?.length, 1);
  // Media instructions only make sense where media generation is on.
  assert.match(html, /ws-default-media-prompt/);
  assert.doesNotMatch(html, /ws-team-media-prompt/);
});

test("policy errors are recognized so the UI can link to the setting", () => {
  assert.equal(isWorkspacePolicyMessage(mediaBlockedMessage), true);
  assert.equal(isWorkspacePolicyMessage("세션을 찾을 수 없습니다."), false);
  assert.equal(isWorkspacePolicyMessage(undefined), false);
});

test("environment settings show this workspace's computer-use state with a link to the switch", () => {
  const render = (workspaceId: string) => renderToStaticMarkup(createElement(WorkspacesContext.Provider, { value: api }, createElement(ComputerUseWorkspaceRows, { workspaceId })));
  const off = render("default");
  assert.match(off, /data-setting-id="env-computer-workspace"/);
  assert.match(off, /꺼짐/);
  assert.match(off, /이 작업 공간에서 켜기/);
  const on = render("team");
  assert.match(on, /이 작업 공간에서 켜짐/);
  assert.match(on, /작업 공간 설정 열기/);
});
