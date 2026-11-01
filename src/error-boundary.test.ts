import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppErrorFallback, ErrorBoundary } from "./ErrorBoundary";

test("error boundary turns render failures into fallback state", () => {
  const error = new Error("boom");
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(error), { error });
});

test("error fallback is accessible and offers a Korean retry action", () => {
  const html = renderToStaticMarkup(createElement(AppErrorFallback, { onRetry() {} }));

  assert.match(html, /<main class="app-error-boundary" role="alert">/);
  assert.match(html, /화면을 표시하지 못했습니다/);
  assert.match(html, /<button[^>]*type="button"[^>]*>다시 시도<\/button>/);
});
