import { test } from "node:test";
import assert from "node:assert/strict";
import { connectPreview, IFRAME_SANDBOX, previewTargetOrigin } from "./browser-messages";

const tabs = [
  { id: "a", proxied: true, proxyOrigin: "http://127.0.0.1:51001" },
  { id: "b", proxied: false },
];

test("a preview frame gets a private channel; only its messages reach the app (L6)", async () => {
  const sent: Array<{ message: unknown; targetOrigin: string; transfer?: unknown[] }> = [];
  const frame = { postMessage: (message: unknown, targetOrigin: string, transfer?: unknown[]) => { sent.push({ message, targetOrigin, transfer }); } };
  const heard: unknown[] = [];
  const port = connectPreview(frame, "http://127.0.0.1:51001", (data) => heard.push(data));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].message, { source: "orchestra-parent", type: "connect" });
  assert.equal(sent[0].targetOrigin, "http://127.0.0.1:51001");
  const injected = sent[0].transfer![0] as MessagePort;
  // The injected script's end: tagged messages come through, anything else is dropped.
  injected.postMessage({ source: "orchestra-preview", type: "location", href: "http://x/" });
  injected.postMessage({ source: "page", type: "agent-result" });
  injected.postMessage("text");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(heard, [{ source: "orchestra-preview", type: "location", href: "http://x/" }]);
  // Commands go the other way over the same channel.
  const commands: unknown[] = [];
  injected.onmessage = (event) => commands.push(event.data);
  port.postMessage({ source: "orchestra-parent", type: "ping" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(commands, [{ source: "orchestra-parent", type: "ping" }]);
  port.close(); injected.close();
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
