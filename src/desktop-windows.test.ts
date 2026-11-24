import test from "node:test";
import assert from "node:assert/strict";
import { clampPosition, desktopStoreKey, loadWindows, loadWorkspaceWindows, newWindow, resizeWindow, MIN_W } from "./desktop-windows";

test("resizing from edges keeps the opposite edge fixed and respects minimums", () => {
  const start = { id: "a", x: 100, y: 100, w: 800, h: 600, z: 1 };
  assert.deepEqual(resizeWindow(start, "se", 50, 20), { ...start, w: 850, h: 620 });
  assert.deepEqual(resizeWindow(start, "nw", 100, 50), { ...start, x: 200, y: 150, w: 700, h: 550 });
  const tiny = resizeWindow(start, "w", 2000, 0);
  assert.equal(tiny.w, MIN_W); assert.equal(tiny.x + tiny.w, 900);
});

test("windows stay reachable and persist", () => {
  const area = { width: 1200, height: 800 };
  const off = clampPosition({ id: "a", x: 5000, y: -50, w: 800, h: 600, z: 1 }, area);
  assert.equal(off.x, 1120); assert.equal(off.y, 0);
  const one = newWindow([], area, "a"), two = newWindow([one], area, "b");
  assert.ok(two.z > one.z && two.x > one.x);
  assert.deepEqual(loadWindows(JSON.stringify([one, { bad: 1 }])), [one]);
  assert.deepEqual(loadWindows("not json"), []);
});

test("snap halves and maximize fill the area and toggle back", async () => {
  const { applySnap, frameOf, desktopMode } = await import("./desktop-windows");
  const area = { width: 1200, height: 800 };
  const win = { id: "a", x: 40, y: 30, w: 700, h: 500, z: 1 };
  const left = applySnap(win, "left");
  assert.deepEqual(frameOf(left, area), { x: 0, y: 0, w: 600, h: 800 });
  assert.deepEqual(frameOf(applySnap(left, "right"), area), { x: 600, y: 0, w: 600, h: 800 });
  assert.deepEqual(frameOf(applySnap(left, "left"), area), { x: 40, y: 30, w: 700, h: 500 });
  const max = applySnap(left, "max");
  assert.deepEqual(frameOf(max, area), { x: 0, y: 0, w: 1200, h: 800 });
  assert.equal(desktopMode([max, { ...win, id: "b", z: 5, snap: "right" }]), "max");
  assert.equal(desktopMode([{ ...max, minimized: true }, { ...win, id: "b", z: 5, snap: "right" }]), "right");
  assert.equal(desktopMode([win]), "none");
});

test("each workspace keeps its own browser windows; the first one inherits the old list", () => {
  const store: Record<string, string> = {
    "orchestra.browser.desktop": JSON.stringify([{ id: "wOld", x: 0, y: 0, w: 800, h: 600, z: 1 }]),
    "orchestra.browser.desktop.company": JSON.stringify([{ id: "wCo", x: 0, y: 0, w: 800, h: 600, z: 1 }]),
  };
  const read = (key: string) => store[key] ?? null;
  assert.deepEqual(loadWorkspaceWindows(read, "company", false).map((w) => w.id), ["wCo"]);
  assert.deepEqual(loadWorkspaceWindows(read, "personal", true).map((w) => w.id), ["wOld"]);
  assert.deepEqual(loadWorkspaceWindows(read, "other", false), []);
  assert.equal(desktopStoreKey("company"), "orchestra.browser.desktop.company");
});

test("a snapped window shares the width with the docked sidebar, the terminal and the chat", async () => {
  const { applySnap, clampSnapWidth, clampSplit, frameOf, snapWidth, CHAT_RAIL, SPLIT_MIN_BROWSER, SPLIT_MIN_CHAT } = await import("./desktop-windows");
  const area = { width: 1480, height: 852 };
  const win = { id: "a", x: 40, y: 30, w: 700, h: 500, z: 1 };
  const room = { left: 280, bottom: 240, split: 0.5, chatCollapsed: false, chatBeside: false };
  // Half of what the sidebar leaves, above the terminal.
  assert.deepEqual(frameOf(applySnap(win, "left"), area, room), { x: 280, y: 0, w: 600, h: 612 });
  assert.deepEqual(frameOf(applySnap(win, "right"), area, room), { x: 880, y: 0, w: 600, h: 612 });
  assert.deepEqual(frameOf(applySnap(win, "max"), area, room), { x: 280, y: 0, w: 1200, h: 612 });
  // A floating window keeps its own frame, wherever the sidebar is.
  assert.deepEqual(frameOf(win, area, room), { x: 40, y: 30, w: 700, h: 500 });
  // The dragged split moves the edge; neither side drops under its minimum.
  assert.equal(frameOf(applySnap(win, "left"), area, { ...room, split: 0.7 }).w, 840);
  assert.equal(snapWidth(area, { ...room, split: 0.01 }), SPLIT_MIN_BROWSER);
  assert.equal(snapWidth(area, { ...room, split: 0.99 }), 1200 - SPLIT_MIN_CHAT);
  assert.equal(clampSnapWidth(5000, 1200), 1200 - SPLIT_MIN_CHAT);
  assert.equal(clampSnapWidth(10, 1200), SPLIT_MIN_BROWSER);
  assert.equal(clampSnapWidth(500, 600), 300, "too narrow for both minimums: halves");
  assert.equal(clampSplit(Number.NaN), 0.5);
  // A maximized window fills everything the sidebar and terminal leave, until the chat is opened beside
  // it: then it shares the width like a left snap (the chat is never laid over the page).
  const beside = { ...room, chatBeside: true };
  assert.deepEqual(frameOf(applySnap(win, "max"), area, beside), { x: 280, y: 0, w: 600, h: 612 });
  assert.deepEqual(frameOf(applySnap(win, "max"), area, { ...beside, split: 0.7 }), { x: 280, y: 0, w: 840, h: 612 });
  assert.deepEqual(frameOf(applySnap(win, "left"), area, beside), { x: 280, y: 0, w: 600, h: 612 }, "a snapped window is not affected");
  // A folded chat keeps only its rail: on the right of a left snap, between the sidebar and a right snap.
  const folded = { ...room, chatCollapsed: true };
  assert.deepEqual(frameOf(applySnap(win, "left"), area, folded), { x: 280, y: 0, w: 1200 - CHAT_RAIL, h: 612 });
  assert.deepEqual(frameOf(applySnap(win, "right"), area, folded), { x: 280 + CHAT_RAIL, y: 0, w: 1200 - CHAT_RAIL, h: 612 });
});
