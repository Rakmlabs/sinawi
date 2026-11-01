import test from "node:test";
import assert from "node:assert/strict";
import { localImageSrc } from "./markdown-images";
test("local markdown images go through the session file endpoint", () => {
  assert.equal(localImageSrc("docs/a b.png", "s1"), "/api/sessions/s1/file?path=docs%2Fa%20b.png");
  assert.equal(localImageSrc("file:///x/y.png", "s1"), "/api/sessions/s1/file?path=%2Fx%2Fy.png");
  assert.equal(localImageSrc("https://e.com/a.png", "s1"), "https://e.com/a.png");
  assert.equal(localImageSrc("data:image/png;base64,AA", "s1"), "data:image/png;base64,AA");
  assert.equal(localImageSrc("a.png", undefined), "a.png");
});
