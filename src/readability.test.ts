import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const css = readFileSync(new URL("./readability.css", import.meta.url), "utf8");

test("readability layer establishes the NEXT9 base and conversation type scale", () => {
  assert.match(css, /:root\s*\{[\s\S]*font-size:\s*15px;[\s\S]*line-height:\s*1\.55;/);
  assert.match(css, /\.message-text\s*\{[\s\S]*font-size:\s*16px;[\s\S]*line-height:\s*1\.55;/);
  assert.match(css, /\.composer textarea\s*\{[\s\S]*font-size:\s*15px;/);
  assert.match(css, /\.rail button,[\s\S]*\.sidebar-empty\s*\{[\s\S]*font-size:\s*14px;/);
});

test("readability layer keeps metadata at twelve pixels or larger at every breakpoint", () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((size) => size >= 12), `found undersized declarations: ${sizes.filter((size) => size < 12).join(", ")}`);
  assert.match(css, /\.sidebar-chat-copy small,[\s\S]*\.sidebar-worker small\s*\{[\s\S]*font-size:\s*12px;/);
  assert.match(css, /@media \(max-width:\s*740px\)[\s\S]*\.activity-summary\s*\{[\s\S]*font-size:\s*12px;/);
});

test("no application stylesheet can override text below the twelve pixel floor", () => {
  const directory = new URL("./", import.meta.url);
  const undersized = readdirSync(directory)
    .filter((file) => file.endsWith(".css") && file !== "fonts.css")
    .flatMap((file) => {
      const source = readFileSync(new URL(file, directory), "utf8");
      return [...source.matchAll(/font-size:\s*([\d.]+)px/g)]
        .map((match) => ({ file, size: Number(match[1]) }))
        .filter(({ size }) => size < 12);
    });
  assert.deepEqual(undersized, []);
});

test("readability layer strengthens glass and secondary text contrast", () => {
  assert.match(css, /--muted:\s*#d9ddd4;/);
  assert.match(css, /\.glass\s*\{\s*background-color:\s*rgba\(28, 35, 29, 0\.86\);/);
  assert.match(css, /\.rail,[\s\S]*\.manual-controls\s*\{\s*background-color:\s*rgba\(25, 33, 27, 0\.9\);/);
  assert.match(css, /color:\s*var\(--muted\);\s*opacity:\s*1;/);
});
