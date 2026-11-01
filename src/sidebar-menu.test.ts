import assert from "node:assert/strict";
import test from "node:test";
import { clampMenu, groupTree } from "./SidebarMenu";

test("group tree lists 미분류 first, nests children by depth and checks the current group", () => {
  const tree = groupTree([{ id: "a", name: "A" }, { id: "b", name: "B", parentId: "a" }, { id: "c", name: "C", parentId: "missing" }], "b");
  assert.deepEqual(tree.map((item) => [item.id, item.depth, item.checked]), [[null, 0, false], ["a", 1, false], ["b", 2, true], ["c", 1, false]]);
  assert.equal(groupTree([{ id: "a", name: "A" }], "gone")[0].checked, true);
});

test("menus stay inside the viewport", () => {
  assert.deepEqual(clampMenu(990, 790, 220, 200, 1000, 800), { left: 772, top: 592 });
  assert.deepEqual(clampMenu(-5, -5, 220, 200, 1000, 800), { left: 8, top: 8 });
});
