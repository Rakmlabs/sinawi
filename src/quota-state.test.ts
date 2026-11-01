import test from "node:test";
import assert from "node:assert/strict";
import { quotaStateReducer, initialQuotaState } from "./quota-state";
test("an older poll cannot replace or clear the result of a newer quota refresh", () => {
  let state = quotaStateReducer(initialQuotaState, { type: "start", id: 1 });
  state = quotaStateReducer(state, { type: "start", id: 2 });
  state = quotaStateReducer(state, { type: "success", id: 2, providers: [{ agent: "claude", windows: [{ key: "five_hour", label: "5시간", remainingPercent: 4 }] }] });
  assert.equal(quotaStateReducer(state, { type: "success", id: 1, providers: [] }), state);
  assert.equal(quotaStateReducer(state, { type: "error", id: 1, error: "old poll failed" }), state);
  assert.equal(state.providers[0].windows[0].remainingPercent, 4);
});
test("a failed refresh preserves observed quotas and exposes its error", () => {
  let state = quotaStateReducer(initialQuotaState, { type: "start", id: 1 });
  state = quotaStateReducer(state, { type: "success", id: 1, providers: [{ agent: "grok", windows: [] }] });
  state = quotaStateReducer(state, { type: "start", id: 2 });
  state = quotaStateReducer(state, { type: "error", id: 2, error: "probe failed" });
  assert.equal(state.error, "probe failed");
  assert.equal(state.providers[0].agent, "grok");
  assert.equal(state.loading, false);
});
