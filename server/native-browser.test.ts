import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { nativeOpenTarget } from "./preview.js";
import { pickerScript } from "./preview-picker.js";

test("native tabs open any http(s) page but never the app or local files", () => {
  assert.deepEqual(nativeOpenTarget("example.com"), { url: "https://example.com/" });
  assert.deepEqual(nativeOpenTarget("https://example.com/a?b=1"), { url: "https://example.com/a?b=1" });
  assert.deepEqual(nativeOpenTarget("5173"), { url: "http://localhost:5173/" });
  assert.match((nativeOpenTarget("3001") as { error: string }).error, /자체 주소/);
  assert.match((nativeOpenTarget("http://127.0.0.1:3073/", 3073) as { error: string }).error, /자체 주소/);
  assert.match((nativeOpenTarget("localhost:4100", 3001, new Set([4100])) as { error: string }).error, /자체 주소/);
  assert.match((nativeOpenTarget("file:///etc/passwd") as { error: string }).error, /http\/https/);
  assert.match((nativeOpenTarget("chrome://settings") as { error: string }).error, /http\/https/);
});

test("native page script is the same script with a native transport", () => {
  const native = pickerScript({ native: true });
  const framed = pickerScript();
  assert.match(native, /var NATIVE = true;/);
  assert.match(framed, /var NATIVE = false;/);
  assert.doesNotThrow(() => new Function(native));
});

/** Minimal browser globals: enough for the script's load-time setup and simple actions. */
function fakePage() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const body = { nodeType: 1, tagName: "BODY", children: [], innerText: "Example Domain", textContent: "Example Domain", getAttribute: () => null, hasAttribute: () => false, matches: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) };
  const document = {
    title: "Example", readyState: "complete", body, documentElement: { appendChild() {}, scrollHeight: 600 },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, activeElement: body,
  };
  const window: Record<string, unknown> = {
    document, location: { href: "https://example.com/" }, history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: "UA", appVersion: "5.0", platform: "MacIntel", maxTouchPoints: 0 },
    console: { error() {}, warn() {}, log() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    setInterval: () => 0, setTimeout: (fn: () => void) => { fn(); return 0; }, clearTimeout() {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", getPropertyValue: () => "" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    XMLHttpRequest: function XMLHttpRequest() {}, Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error, URL, RegExp,
  };
  (window.XMLHttpRequest as { prototype: object }).prototype = { open() {}, send() {} };
  window.window = window; window.top = window; window.parent = window; window.self = window;
  return { window, listeners };
}

test("native page script answers run() and queues events for the app to drain", async () => {
  const { window, listeners } = fakePage();
  runInNewContext(pickerScript({ native: true }), window);
  const api = window.__aoNative as { run: (a: string, b?: object) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>; send: (d: object) => boolean; drain: () => { type: string }[] };
  assert.ok(api, "window.__aoNative is defined");
  assert.throws(() => { (window as { __aoNative: unknown }).__aoNative = null; }, TypeError);
  const status = await api.run("status");
  assert.equal(status.ok, true);
  assert.equal(status.result?.url, "https://example.com/");
  const text = await api.run("text");
  assert.equal(text.result?.text, "Example Domain");
  const rect = await api.run("rect");
  assert.equal(JSON.stringify(rect.result?.rect), JSON.stringify({ x: 0, y: 0, width: 800, height: 600 }));
  const unknown = await api.run("nope");
  assert.equal(unknown.ok, false);
  const drained = api.drain();
  assert.ok(drained.some((event) => event.type === "location"));
  assert.equal(api.drain().length, 0);
  // The page's own postMessage cannot drive a native tab.
  for (const fn of listeners.message ?? []) fn({ data: { source: "orchestra-parent", type: "agent", id: "x", action: "status" } });
  assert.equal(api.drain().length, 0);
});

test("framed page script stays inert outside an iframe", () => {
  const { window } = fakePage();
  runInNewContext(pickerScript(), window);
  assert.equal(window.__aoNative, undefined);
});

test("page script forwards shortcuts only for trusted key events", () => {
  const { window, listeners } = fakePage();
  runInNewContext(pickerScript({ native: true }), window);
  const api = window.__aoNative as { drain: () => { type: string }[] };
  api.drain();
  const key = { key: "w", code: "KeyW", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, target: null };
  for (const fn of listeners.keydown ?? []) fn({ ...key, isTrusted: false });
  assert.equal(api.drain().filter((event) => event.type === "shortcut").length, 0);
  for (const fn of listeners.keydown ?? []) fn({ ...key, isTrusted: true });
  assert.equal(api.drain().filter((event) => event.type === "shortcut").length, 1);
});
