import test from "node:test";
import assert from "node:assert/strict";
import { afterEdgeClick, afterRailToggle, railCollapsed, railToggleLabel } from "./sidebar-rail";

test("a collapsed rail ignores hover and opens only from an explicit click", () => {
  assert.equal(railCollapsed(true, false, false), true);
  assert.equal(railCollapsed(false, true, false), true);
  const opened = afterEdgeClick();
  assert.equal(railCollapsed(opened.sidebarCollapsed, true, opened.pinnedOpen), false);
  const hiddenAgain = afterRailToggle(false);
  assert.equal(railCollapsed(hiddenAgain.sidebarCollapsed, false, hiddenAgain.pinnedOpen), true);
  const shownFromHidden = afterRailToggle(true);
  assert.equal(railCollapsed(shownFromHidden.sidebarCollapsed, true, shownFromHidden.pinnedOpen), false);
});

test("sidebar labels follow the collapsed state", () => {
  assert.equal(railToggleLabel(true), "사이드바 펼치기");
  assert.equal(railToggleLabel(false), "사이드바 접기");
});
