import test from "node:test";
import assert from "node:assert/strict";
import { holdUrl, linkTarget, takeHeldUrl } from "./link-open";

test("web links get the browser choice, mail-style links go to the system, the rest stay put", () => {
  assert.equal(linkTarget("http://127.0.0.1:3311"), "web");
  assert.equal(linkTarget("https://example.com"), "web");
  assert.equal(linkTarget("mailto:a@b.kr"), "system");
  assert.equal(linkTarget("/api/x"), "none");
  assert.equal(linkTarget("example.com"), "none");
  assert.equal(linkTarget("javascript:alert(1)"), "none");
});

test("a held URL is handed over once", () => {
  holdUrl("https://example.com");
  assert.equal(takeHeldUrl(), "https://example.com");
  assert.equal(takeHeldUrl(), undefined);
});
