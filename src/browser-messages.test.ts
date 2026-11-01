import { test } from "node:test";
import assert from "node:assert/strict";
import { IFRAME_SANDBOX, previewTargetOrigin, trustedPreviewSender } from "./browser-messages";

const own = {};
const other = {};
const frames = new Map([["a", { contentWindow: own }], ["b", { contentWindow: {} }]]);
const tabs = [
  { id: "a", proxied: true, proxyOrigin: "http://127.0.0.1:51001" },
  { id: "b", proxied: false },
];
const data = { source: "orchestra-preview", type: "location" };

test("preview messages are accepted only from our own iframe at its proxy origin", () => {
  assert.equal(trustedPreviewSender({ data, origin: "http://127.0.0.1:51001", source: own }, frames, tabs), "a");
  assert.equal(trustedPreviewSender({ data, origin: "http://127.0.0.1:51001", source: other }, frames, tabs), undefined, "foreign window");
  assert.equal(trustedPreviewSender({ data, origin: "http://127.0.0.1:51001", source: null }, frames, tabs), undefined, "no source");
  assert.equal(trustedPreviewSender({ data, origin: "https://evil.example", source: own }, frames, tabs), undefined, "navigated away");
  assert.equal(trustedPreviewSender({ data, origin: "null", source: own }, frames, tabs), undefined, "opaque origin");
  assert.equal(trustedPreviewSender({ data: { ...data, source: "x" }, origin: "http://127.0.0.1:51001", source: own }, frames, tabs), undefined, "untagged");
  assert.equal(trustedPreviewSender({ data: "text", origin: "http://127.0.0.1:51001", source: own }, frames, tabs), undefined, "non-object");
  assert.equal(trustedPreviewSender({ data: { ...data, type: "agent-stop" }, origin: "https://site.example", source: frames.get("b")!.contentWindow }, frames, tabs), undefined, "external (unproxied) tab");
});

test("app-to-frame messages target the proxy origin only", () => {
  assert.equal(previewTargetOrigin(tabs[0]), "http://127.0.0.1:51001");
  assert.equal(previewTargetOrigin(tabs[1]), undefined);
  assert.equal(previewTargetOrigin(undefined), undefined);
});

test("preview iframe sandbox keeps dev-page features but not top navigation", () => {
  const tokens = IFRAME_SANDBOX.split(" ");
  for (const token of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-modals", "allow-downloads"]) assert.ok(tokens.includes(token), token);
  assert.ok(!tokens.some((token) => token.startsWith("allow-top-navigation")));
});
