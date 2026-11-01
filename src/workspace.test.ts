import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePill, workspaceTargetLabel } from "./WorkspacePill";

test("workspace pill names the current workspace and the toggle target", () => {
  const personal = renderToStaticMarkup(createElement(WorkspacePill, { workspaceId: "personal", onSwitch: () => {} }));
  const company = renderToStaticMarkup(createElement(WorkspacePill, { workspaceId: "company", onSwitch: () => {} }));
  assert.match(personal, /workspace-pill personal/);
  assert.match(personal, />개인</);
  assert.match(personal, /aria-label="개인 작업 공간, 회사로 전환"/);
  assert.match(company, /workspace-pill company/);
  assert.match(company, />회사</);
  assert.match(company, /aria-label="회사 작업 공간, 개인으로 전환"/);
  assert.equal(workspaceTargetLabel("personal"), "회사로 이동");
  assert.equal(workspaceTargetLabel("company"), "개인으로 이동");
});

test("workspace pill announces running work in the other workspace", () => {
  const html = renderToStaticMarkup(createElement(WorkspacePill, { workspaceId: "personal", onSwitch: () => {}, otherRunning: 3 }));
  assert.match(html, /workspace-running-badge/);
  assert.match(html, /회사에서 진행 중인 작업 3개/);
  assert.match(html, />3</);
  const idle = renderToStaticMarkup(createElement(WorkspacePill, { workspaceId: "company", onSwitch: () => {}, otherRunning: 0 }));
  assert.doesNotMatch(idle, /workspace-running-badge/);
});

