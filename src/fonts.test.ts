import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Pretendard ships locally with variable weights and its license", () => {
  const font = readFileSync(new URL("./assets/fonts/PretendardVariable.woff2", import.meta.url));
  assert.equal(font.toString("ascii", 0, 4), "wOF2");
  const css = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
  assert.match(css, /font-family: "Pretendard Variable"/);
  assert.match(css, /url\("\.\/assets\/fonts\/PretendardVariable.woff2"\)/);
  assert.match(css, /font-weight: 100 900/);
  assert.match(css, /font-display: swap/);
  assert.match(readFileSync(new URL("./assets/fonts/OFL.txt", import.meta.url), "utf8"), /SIL OPEN FONT LICENSE/);
});
