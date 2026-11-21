import assert from "node:assert/strict";
import test from "node:test";
import { approvalSource } from "./AppApprovals";
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
