import test from "node:test";
import assert from "node:assert/strict";
import { accessibleRole, formatNode } from "./browser-snapshot.js";
import { pickerScript } from "./preview-picker.js";

test("accessible roles follow implicit ARIA and keep file inputs visible", () => {
  assert.equal(accessibleRole("button", "", "", false), "button");
  assert.equal(accessibleRole("button", "", "switch", false), "switch");
  assert.equal(accessibleRole("a", "", "", false), "link");
  assert.equal(accessibleRole("input", "email", "", false), "textbox");
  assert.equal(accessibleRole("input", "checkbox", "", false), "checkbox");
  assert.equal(accessibleRole("input", "file", "", false), "input[file]");
  assert.equal(accessibleRole("input", "submit", "", false), "button");
  assert.equal(accessibleRole("input", "hidden", "", false), "");
  assert.equal(accessibleRole("h2", "", "", false), "heading");
  assert.equal(accessibleRole("nav", "", "", false), "navigation");
  assert.equal(accessibleRole("div", "", "", true), "textbox");
  assert.equal(accessibleRole("div", "", "", false), "");
});

test("snapshot lines keep bracket refs and indent the tree", () => {
  assert.equal(formatNode(0, "button", "저장", "e12", []), `[e12] button "저장"`);
  assert.equal(formatNode(1, "textbox", "이메일", "e3", ["value=\"a@b.c\""]), `  [e3] textbox "이메일" value="a@b.c"`);
  assert.equal(formatNode(0, "heading", "제목", "e1", ["[level=1]"]), `[e1] heading "제목" [level=1]`);
  assert.equal(formatNode(0, "navigation", "", undefined, []), "navigation");
});

test("the injected picker builds an a11y snapshot and waits for network idle", () => {
  const src = pickerScript();
  assert.match(src, /function accessibleRole/);
  assert.match(src, /function formatNode/);
  assert.match(src, /networkidle/);
  assert.match(src, /input\[file\]/);
  assert.match(src, /data-ao-ref/);
  assert.doesNotMatch(src, /__ROLE__|__NODE__/);
  assert.match(src, /width=" \+ px \+ ", initial-scale=1, minimum-scale=1, maximum-scale=1/);
  assert.match(src, /function lockViewport/);
  assert.doesNotMatch(src, /\/\s*(window\.)?devicePixelRatio/);
});
