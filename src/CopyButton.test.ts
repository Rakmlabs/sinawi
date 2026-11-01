import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton, writeClipboard } from "./CopyButton";

test("clipboard helper reports success without changing copied text", async () => {
  let copied = "";
  const ok = await writeClipboard("exact text", { writeText: async (text) => { copied = text; } });
  assert.equal(ok, true);
  assert.equal(copied, "exact text");
});

test("clipboard helper reports rejected and unavailable clipboard access", async () => {
  assert.equal(await writeClipboard("text", { writeText: async () => { throw new Error("denied"); } }), false);
  assert.equal(await writeClipboard("text", undefined), false);
});

test("copy control reserves an accessible live status for success or failure feedback", () => {
  const html = renderToStaticMarkup(createElement(CopyButton, { text: "copy me", ariaLabel: "메시지 복사" }));
  assert.match(html, /aria-label="메시지 복사"/);
  assert.match(html, /role="status" aria-live="polite"/);
});
