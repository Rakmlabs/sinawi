import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRegistry } from "./browser-registry";

test("last focused browser window owns commands; falls back when it closes", () => {
  const r = createBrowserRegistry();
  const unA = r.mount("a"); r.mount("b");
  assert.ok(r.isActive("b"));
  r.activate("a"); assert.ok(r.isActive("a")); assert.ok(!r.isActive("b"));
  unA(); assert.ok(r.isActive("b")); assert.equal(r.count(), 1);
});

test("native menu routes to the active window", () => {
  const r = createBrowserRegistry(); const w: { __orchestraMenuCloseTab?: () => void } = {};
  const calls: string[] = [];
  r.mount("a"); r.mount("b");
  r.handlers("a", { reload() {}, closeTab: () => calls.push("a") }, w);
  r.handlers("b", { reload() {}, closeTab: () => calls.push("b") }, w);
  r.activate("a"); w.__orchestraMenuCloseTab!();
  r.activate("b"); w.__orchestraMenuCloseTab!();
  assert.deepEqual(calls, ["a", "b"]);
});

test("⌘W only targets a browser window after it was clicked, never the app", () => {
  const registry = createBrowserRegistry();
  registry.setDesktopFocused(true);
  assert.equal(registry.desktopFocused(), false, "no windows mounted");
  const unmount = registry.mount("w1");
  assert.equal(registry.desktopFocused(), true);
  registry.setDesktopFocused(false);
  assert.equal(registry.desktopFocused(), false);
  unmount();
});

test("each workspace has its own primary browser; only the one on screen is active", () => {
  let screen = "personal";
  const r = createBrowserRegistry(() => screen);
  r.mount("p1", "personal"); r.mount("c1", "company"); r.mount("c2", "company");
  assert.equal(r.active(), "p1");
  assert.ok(r.isPrimary("c2", "company"), "the off-screen company browser still serves company agents");
  r.activate("c1");
  assert.ok(r.isPrimary("c1", "company"));
  assert.equal(r.active(), "p1", "activating a company window does not take over the screen");
  assert.equal(r.count(), 1);
  assert.equal(r.countIn("company"), 2);
  screen = "company";
  assert.equal(r.active(), "c1");
  assert.equal(r.count(), 2);
});
