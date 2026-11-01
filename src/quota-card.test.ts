import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaCard } from "./QuotaCard";
const now = Date.parse("2026-10-30T00:00:00Z");
test("remaining card renders real accessible windows, warnings and KST resets", () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { agent: "codex", now, provider: { agent: "codex", updatedAt: "2026-10-30T00:00:00Z", windows: [{ key: "primary", label: "5시간", remainingPercent: 4, resetsAt: now / 1000 + 3600 }] } }));
  assert.match(html, /남은 한도/);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuenow="4"/);
  assert.match(html, /quota-window low/);
  assert.match(html, /KST/);
  assert.match(html, /1시간 후 초기화/);
});
test("unknown Grok quota remains unavailable alongside reported session totals", () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { agent: "grok", now, tokens: 1234 }));
  assert.match(html, /남은 한도 정보 제공 안 함/);
  assert.match(html, /1,234/);
  assert.doesNotMatch(html, /role="meter"|100%/);
});
test("expired windows show an observation requiring refresh instead of an active meter", () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { agent: "claude", now, provider: { agent: "claude", windows: [{ key: "a", label: "주간", remainingPercent: 4, resetsAt: now / 1000 - 1 }] } }));
  assert.match(html, /다시 확인 필요/);
  assert.doesNotMatch(html, /role="meter"/);
});

test("old observations without a reset are labeled stale and do not draw an active meter", () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { agent: "claude", now, provider: { agent: "claude", updatedAt: "2026-10-27T00:00:00Z", windows: [{ key: "a", label: "5시간", remainingPercent: 4 }] } }));
  assert.match(html, /다시 확인 필요/);
  assert.doesNotMatch(html, /role="meter"/);
});
test("failed session token loading exposes an error and retry beside Grok", () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { agent: "grok", now, tokenError: "연결 오류", onRetryTokens: () => {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /연결 오류/);
  assert.match(html, /기록 다시 시도/);
  assert.doesNotMatch(html, /합계: 정보 없음/);
});
