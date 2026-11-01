import test from "node:test";
import assert from "node:assert/strict";
import { isNearChatBottom, streamingAssistantMessageId } from "./chat-scroll";

test("chat follows new output only while the reader is near the bottom", () => {
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }), true);
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 }), false);
});

test("chat bottom tolerance includes short and exactly fitting conversations", () => {
  assert.equal(isNearChatBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 }), true);
  assert.equal(isNearChatBottom({ scrollHeight: 1000, scrollTop: 480, clientHeight: 400 }, 120), true);
});

test("streaming caret only targets an assistant response in the current user turn", () => {
  const previous = { id: "assistant-1", type: "message", agent: "codex" };
  const user = { id: "user-2", type: "message", agent: "user" };
  assert.equal(streamingAssistantMessageId([previous, user], true), undefined);
  assert.equal(streamingAssistantMessageId([previous, user, { id: "task", type: "delegation", agent: "claude" }], true), undefined);
  assert.equal(streamingAssistantMessageId([previous, user, { id: "assistant-2", type: "message", agent: "codex" }], true), "assistant-2");
  assert.equal(streamingAssistantMessageId([previous, user, { id: "assistant-2", type: "message", agent: "codex" }], false), undefined);
  assert.equal(streamingAssistantMessageId([previous, user, { id: "status", type: "message", agent: "grok", aside: true }, { id: "assistant-2", type: "message", agent: "codex" }], true), "assistant-2");
  assert.equal(streamingAssistantMessageId([previous, { id: "aside-user", type: "message", agent: "user", aside: true }, user, { id: "status", type: "message", agent: "grok", aside: true }], true), undefined);
});
