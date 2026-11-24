import test from "node:test";
import assert from "node:assert/strict";
import { browserWindowPath, browserWindowSocketPath, browserWindowTarget, forgetOutside, lostOutside, OUTSIDE_OPENING_MS, rememberedOutside, rememberOutside, stillOpening } from "./browser-window";
import { loadSavedTabs } from "./browser-surface";

test("a browser window outside the app is this page with its window and workspace ids in the address", () => {
  const target = { id: "wk3j9x0ab", workspaceId: "ws-9dc35785" };
  assert.equal(browserWindowPath(target), "/?browser-window=wk3j9x0ab&workspace=ws-9dc35785");
  assert.deepEqual(browserWindowTarget("?browser-window=wk3j9x0ab&workspace=ws-9dc35785"), target);
  assert.equal(browserWindowSocketPath(target), "/ws/browser?workspace=ws-9dc35785&id=wk3j9x0ab");
  // The app window itself, and addresses that are not plain ids.
  assert.equal(browserWindowTarget(""), undefined);
  assert.equal(browserWindowTarget("?browser-window=w1"), undefined);
  assert.equal(browserWindowTarget("?browser-window=..%2Fx&workspace=personal"), undefined);
  assert.equal(browserWindowTarget("?browser-window=w1&workspace=a%20b"), undefined);
});

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test("windows moved out are remembered per workspace until they come back", () => {
  const store = memory();
  rememberOutside("personal", "w1", store);
  rememberOutside("personal", "w1", store);
  rememberOutside("personal", "w2", store);
  rememberOutside("company", "w9", store);
  assert.deepEqual(rememberedOutside("personal", store), ["w1", "w2"]);
  assert.deepEqual(rememberedOutside("company", store), ["w9"]);
  forgetOutside("personal", "w1", store);
  assert.deepEqual(rememberedOutside("personal", store), ["w2"]);
  forgetOutside("personal", "w2", store);
  assert.equal(store.data.has("orchestra.browser.outside.personal"), false, "nothing left: the key goes too");
  store.setItem("orchestra.browser.outside.personal", "not json");
  assert.deepEqual(rememberedOutside("personal", store), []);
  store.setItem("orchestra.browser.outside.personal", JSON.stringify(["ok", 3, "bad id", null]));
  assert.deepEqual(rememberedOutside("personal", store), ["ok"]);
});

test("a window moved out moments ago is still opening, not lost; one remembered from an earlier run is not", () => {
  const store = memory();
  rememberOutside("personal", "wNew", store, 1_000);
  assert.equal(stillOpening("wNew", 1_000 + OUTSIDE_OPENING_MS - 1), true);
  assert.equal(stillOpening("wNew", 1_000 + OUTSIDE_OPENING_MS), false, "it had its time to connect");
  // Saved by an earlier run of the app (only the store knows it): nothing to wait for.
  store.setItem("orchestra.browser.outside.personal", JSON.stringify(["wNew", "wOld"]));
  assert.equal(stillOpening("wOld", 1_000), false);
  forgetOutside("personal", "wNew", store);
  assert.equal(stillOpening("wNew", 1_001), false, "back in the app: no longer waited for");
});

test("a remembered window that is not open outside counts as lost, per workspace", () => {
  const open = [{ id: "w1", workspaceId: "personal" }, { id: "w2", workspaceId: "company" }];
  assert.deepEqual(lostOutside(["w1", "w2", "w3"], open, "personal"), ["w2", "w3"], "w2 is open, but in another workspace");
  assert.deepEqual(lostOutside(["w1"], open, "personal"), []);
  assert.deepEqual(lostOutside([], open, "personal"), []);
});

test("a window's saved tabs come back with the one that was on screen", () => {
  let n = 0;
  const make = (tab: { url?: string; title?: string }) => ({ id: `t${++n}`, url: tab.url ?? "", title: tab.title ?? "" });
  const blank = () => ({ id: `blank${++n}`, url: "", title: "" });
  const saved = JSON.stringify({ tabs: [{ url: "http://localhost:3000/", title: "a" }, { url: "https://example.com/", title: "b" }], active: 1 });
  const loaded = loadSavedTabs(saved, make, blank);
  assert.deepEqual(loaded.tabs.map((tab) => tab.url), ["http://localhost:3000/", "https://example.com/"]);
  assert.equal(loaded.activeId, loaded.tabs[1].id);
  // Saved before the active tab was kept, or out of range: the first tab.
  const old = loadSavedTabs(JSON.stringify({ tabs: [{ url: "http://localhost:3000/" }] }), make, blank);
  assert.equal(old.activeId, old.tabs[0].id);
  const off = loadSavedTabs(JSON.stringify({ tabs: [{ url: "http://localhost:3000/" }], active: 7 }), make, blank);
  assert.equal(off.activeId, off.tabs[0].id);
  // Nothing saved, or junk: one blank tab.
  for (const raw of [null, "junk", JSON.stringify({ tabs: [] })]) {
    const empty = loadSavedTabs(raw, make, blank);
    assert.equal(empty.tabs.length, 1);
    assert.equal(empty.tabs[0].url, "");
    assert.equal(empty.activeId, empty.tabs[0].id);
  }
});
