import assert from "node:assert/strict";
import test from "node:test";
import { showSessionAction } from "./show-session";

test("show_session takes the screen only from an empty, untouched new-chat screen", () => {
  const base = { requested: "a", tab: "workspace", prompt: "", drafting: false, lastInputAt: 0, now: 60_000 };
  assert.equal(showSessionAction(base), "open");
  assert.equal(showSessionAction({ ...base, selected: "a" }), "already");
  assert.equal(showSessionAction({ ...base, selected: "b" }), "notify", "another chat is open");
  assert.equal(showSessionAction({ ...base, prompt: "쓰는 중" }), "notify", "an unsent message");
  assert.equal(showSessionAction({ ...base, drafting: true }), "notify", "a new lead being set up");
  assert.equal(showSessionAction({ ...base, tab: "settings" }), "notify", "settings open");
  assert.equal(showSessionAction({ ...base, lastInputAt: 50_000 }), "notify", "typed or clicked a moment ago");
});
