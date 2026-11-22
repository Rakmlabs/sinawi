import assert from "node:assert/strict";
import test from "node:test";
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./app/SidebarResizer";

test("the sidebar width stays between its limits and falls back to the default on nonsense", () => {
  assert.equal(clampSidebar(100), SIDEBAR_MIN);
  assert.equal(clampSidebar(10_000), SIDEBAR_MAX);
  assert.equal(clampSidebar(300.4), 300);
  assert.equal(clampSidebar(Number.NaN), SIDEBAR_DEFAULT);
});
