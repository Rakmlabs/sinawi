import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "../server/types";
import { QuietIndicator } from "./app/QuietIndicator";

test("activity elapsed mode does not repeat the tool line", () => {
  const since = new Date(Date.now() - 5_000).toISOString();
  const events = [{ id: "tool", sessionId: "s", agent: "codex", role: "worker", workerLabel: "Codex", type: "tool", text: "파일 읽기: src/app.tsx", time: since }] as SessionEvent[];
  const html = renderToStaticMarkup(createElement(QuietIndicator, { session: { status: "running", events }, activityElapsedOnly: true }));
  assert.doesNotMatch(html, /파일 읽기/);
  assert.match(html, /quiet-indicator/);
});
