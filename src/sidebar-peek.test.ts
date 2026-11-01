import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("collapsed sidebar no longer peeks open on hover", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./browser.css", import.meta.url), "utf8");
  assert.doesNotMatch(main, /sidebar-peek|sidebar-hotzone|sidebarPeek/);
  assert.doesNotMatch(css, /sidebar-peek|sidebar-hotzone|sidebar-hover/);
  assert.match(main, /aria-label="사이드바 펼치기"/);
  assert.doesNotMatch(main, /aria-label="스킬 첨부"|label="작업 그룹"/);
});
