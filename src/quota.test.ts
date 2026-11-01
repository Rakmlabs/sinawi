import test from "node:test";
import assert from "node:assert/strict";
import { remainingQuota, resetCountdown, formatKst } from "./quota-data";
const now = Date.parse("2026-10-30T00:00:00Z");
test("compact quota uses the tightest valid window and never assumes a reset refills quota", () => {
  assert.equal(remainingQuota({ agent: "codex", updatedAt: new Date(now).toISOString(), windows: [{ key: "a", label: "5시간", remainingPercent: 30 }, { key: "b", label: "주간", remainingPercent: 4 }] }, now), 4);
  assert.equal(remainingQuota({ agent: "claude", windows: [] }, now), undefined);
  assert.equal(remainingQuota({ agent: "codex", updatedAt: new Date(now).toISOString(), windows: [{ key: "a", label: "5시간", remainingPercent: 4, resetsAt: now / 1000 - 1 }] }, now), undefined);
  assert.equal(remainingQuota({ agent: "grok", windows: [{ key: "a", label: "5시간", remainingPercent: NaN }] }, now), undefined);
});
test("reset countdown and timestamps remain honest and use Korea time", () => {
  assert.equal(resetCountdown(now / 1000 + 3660, now), "1시간 1분 후 초기화");
  assert.equal(resetCountdown(now / 1000 - 1, now), "초기화 시각 지남 · 다시 확인 필요");
  assert.equal(resetCountdown(undefined, now), "초기화 시각 정보 없음");
  assert.match(formatKst("2026-10-30T00:00:00Z"), /09:00/);
  assert.equal(formatKst("bad"), "정보 없음");
});

test("stale quota without a reset timestamp cannot remain a current compact indicator", () => {
  assert.equal(remainingQuota({ agent: "claude", updatedAt: "2026-10-27T00:00:00Z", windows: [{ key: "a", label: "5시간", remainingPercent: 4 }] }, now), undefined);
});
