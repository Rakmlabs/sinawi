import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { externalUrl, registerOpenExternalRoute } from "./open-external.js";

test("only web and mail-style links open externally", () => {
  assert.equal(externalUrl("http://127.0.0.1:3311"), "http://127.0.0.1:3311/");
  assert.equal(externalUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(externalUrl("mailto:a@b.kr"), "mailto:a@b.kr");
  assert.equal(externalUrl("file:///etc/passwd"), undefined);
  assert.equal(externalUrl("/Applications/Calculator.app"), undefined);
  assert.equal(externalUrl("javascript:alert(1)"), undefined);
  assert.equal(externalUrl(42), undefined);
});

test("the route launches the checked URL and rejects the rest", async () => {
  const opened: string[] = [];
  const app = express().use(express.json());
  registerOpenExternalRoute(app, (url, done) => { opened.push(url); done(null); });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const post = (url: string) => fetch(`http://127.0.0.1:${port}/api/open-external`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  try {
    assert.equal((await post("https://example.com")).status, 200);
    assert.equal((await post("file:///tmp/x")).status, 400);
    assert.deepEqual(opened, ["https://example.com/"]);
  } finally { server.close(); }
});
