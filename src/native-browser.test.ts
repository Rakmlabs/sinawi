import test from "node:test";
import assert from "node:assert/strict";
import { agentCallBody, captureRect, isCovered, layoutKey, NAVIGATED_NOTE, nativeBrowserAvailable, nativeFocusedTab, navigationOutcome, NO_SCRIPT, parseEvents, parseNativeResult, samplePoints, sendBody, slotBounds } from "./native-browser";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

test("native tabs need the Tauri app on macOS and can be turned off", () => {
  const app = { __TAURI_INTERNALS__: { invoke: async () => undefined } };
  assert.equal(nativeBrowserAvailable(app, "MacIntel", null), true);
  assert.equal(nativeBrowserAvailable(app, "MacIntel", "iframe"), false);
  assert.equal(nativeBrowserAvailable({}, "MacIntel", null), false);
  assert.equal(nativeBrowserAvailable(app, "Win32", null), false);
});

test("slot bounds are rounded, clipped to the window and dropped when empty", () => {
  assert.deepEqual(slotBounds({ left: 800.4, top: 120.6, width: 600.2, height: 700 }, 1440, 900), { x: 800, y: 121, width: 600, height: 700 });
  assert.deepEqual(slotBounds({ left: 1200, top: 100, width: 600, height: 900 }, 1440, 900), { x: 1200, y: 100, width: 240, height: 800 });
  assert.equal(slotBounds({ left: 0, top: 0, width: 0, height: 500 }, 1440, 900), undefined);
  assert.equal(slotBounds({ left: 1500, top: 0, width: 100, height: 100 }, 1440, 900), undefined);
});

test("any app element over the slot covers the native view", () => {
  const rect = { x: 100, y: 100, width: 400, height: 300 };
  assert.equal(samplePoints(rect).length, 9);
  assert.deepEqual(samplePoints(rect)[0], [116, 116]);
  const slot = { contains: (node: unknown) => node === child };
  const child = { name: "child" };
  const menu = { name: "menu" };
  assert.equal(isCovered(rect, () => slot, slot), false);
  assert.equal(isCovered(rect, () => child, slot), false);
  assert.equal(isCovered(rect, () => null, slot), false);
  // A dropdown over the top-right corner only.
  assert.equal(isCovered(rect, (x, y) => (x > 400 && y < 150 ? menu : slot), slot), true);
});

test("layout keys change only when what Rust must do changes", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  assert.equal(layoutKey("a", rect, true, 1), layoutKey("a", { ...rect }, true, 1));
  assert.notEqual(layoutKey("a", rect, true, 1), layoutKey("a", rect, true, 0.5));
  assert.notEqual(layoutKey("a", rect, true, 1), layoutKey("b", rect, true, 1));
  assert.equal(layoutKey("a", rect, false, 1), layoutKey("a", { ...rect, x: 9 }, false, 1));
});

test("agent calls run through the page script and come back as JSON text", async () => {
  const calls: unknown[] = [];
  const window = { __aoNative: { run: async (action: string, args: unknown) => { calls.push([action, args]); return { ok: true, result: { snapshot: "# t", quote: "\"</script>" } }; } } };
  const body = agentCallBody("click", { ref: "e3", text: "a\"b c" });
  const raw = await new AsyncFunction("window", body)(window);
  assert.deepEqual(calls, [["click", { ref: "e3", text: "a\"b c" }]]);
  assert.deepEqual(parseNativeResult(raw), { ok: true, result: { snapshot: "# t", quote: "\"</script>" }, error: undefined });
  const missing = await new AsyncFunction("window", body)({});
  assert.deepEqual(parseNativeResult(missing), { ok: false, result: undefined, error: NO_SCRIPT });
});

test("control messages are tagged and need the page script", async () => {
  const sent: unknown[] = [];
  const window = { __aoNative: { send: (message: unknown) => { sent.push(message); } } };
  assert.equal(await new AsyncFunction("window", sendBody({ type: "pick", on: true }))(window), "ok");
  assert.deepEqual(sent, [{ source: "orchestra-parent", type: "pick", on: true }]);
  assert.equal(await new AsyncFunction("window", sendBody({ type: "pick" }))({}), null);
});

test("results are shaped for the bridge", () => {
  assert.deepEqual(parseNativeResult(null), { ok: false, error: NO_SCRIPT });
  assert.equal(parseNativeResult("not json").ok, false);
  assert.deepEqual(parseNativeResult(JSON.stringify({ ok: false, error: "요소를 찾을 수 없습니다" })), { ok: false, result: undefined, error: "요소를 찾을 수 없습니다" });
  assert.equal(parseNativeResult(42).ok, false);
});

test("a call cut off by navigation reports navigated, other failures stay errors", () => {
  assert.deepEqual(navigationOutcome("WKError 4: x", { url: "https://a.test/" }, { url: "https://a.test/next", loading: false }), { ok: true, result: { navigated: true, from: "https://a.test/", url: "https://a.test/next", note: NAVIGATED_NOTE } });
  assert.equal(navigationOutcome("WKError 4: x", { url: "https://a.test/" }, { url: "https://a.test/", loading: true })?.ok, true);
  assert.equal(navigationOutcome("WKError 3: invalidated", { url: "https://a.test/" }, { url: "https://a.test/" })?.ok, true);
  assert.equal(navigationOutcome("WKError 4: TypeError", { url: "https://a.test/" }, { url: "https://a.test/", loading: false }), undefined);
});

test("page events are parsed defensively", () => {
  assert.deepEqual(parseEvents(JSON.stringify([{ type: "picking", on: true }, null, 3, { nope: 1 }])), [{ type: "picking", on: true }]);
  assert.deepEqual(parseEvents(null), []);
  assert.deepEqual(parseEvents("{"), []);
});

test("picked element rects become viewport crops", () => {
  assert.deepEqual(captureRect({ x: 100, y: 1300, width: 50, height: 20 }, { scrollX: 0, scrollY: 1000 }), { x: 100, y: 300, width: 50, height: 20 });
  assert.deepEqual(captureRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
});

test("menu focus hint names a native tab", () => {
  assert.equal(nativeFocusedTab({ __orchestraNativeFocus: "abc" }), "abc");
  assert.equal(nativeFocusedTab({ __orchestraNativeFocus: null }), undefined);
  assert.equal(nativeFocusedTab({}), undefined);
});
