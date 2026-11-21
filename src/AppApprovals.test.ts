import assert from "node:assert/strict";
import test from "node:test";
import { approvalSource, waitsElsewhere } from "./AppApprovals";
import { setLang, t } from "./i18n";

test("an approval card names who asked before any ID", () => {
  setLang("ko");
  assert.equal(approvalSource({ source: "lead", requester: "백엔드" }), "담당 '백엔드'");
  assert.equal(approvalSource({ source: "lead" }), "담당");
  assert.equal(approvalSource({ source: "external" }), "외부 AI");
  assert.equal(approvalSource({ source: "external", requester: "grok-bot" }), "외부 AI 'Grok Bot'", "the MCP client by its product name");
  assert.equal(t("approval.title", { source: approvalSource({ source: "external", requester: "claude-code" }) }), "외부 AI 'Claude Code'가 승인을 기다립니다");
  assert.equal(t("approval.title", { source: approvalSource({ source: "lead", requester: "결제" }) }), "담당 '결제'가 승인을 기다립니다");
});

test("another chat's approval is one line; the open chat's, or one with no chat, is a full card", () => {
  assert.equal(waitsElsewhere("other", "open"), true);
  assert.equal(waitsElsewhere("open", "open"), false);
  assert.equal(waitsElsewhere(undefined, "open"), false, "no chat: nowhere else to answer it");
  assert.equal(waitsElsewhere("other", undefined), true, "the new-chat screen is not that chat either");
});
