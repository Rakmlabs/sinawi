import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const css = readFileSync(new URL("./readability.css", import.meta.url), "utf8");
const directory = new URL("./", import.meta.url);
const stylesheets = readdirSync(directory)
  .filter((file) => file.endsWith(".css"))
  .map((file) => ({ file, source: readFileSync(new URL(file, directory), "utf8") }));
const scaled = (px: number) => `calc\\(${px}px \\* var\\(--font-scale\\)\\)`;
// Matches both `font-size: 12px` and `font-size: calc(12px * var(--font-scale))`.
const fontSizes = (source: string) => [...source.matchAll(/font-size:\s*(?:calc\()?([\d.]+)px/g)].map((match) => Number(match[1]));

test("readability layer establishes the base and conversation type scale", () => {
  assert.match(css, new RegExp(`:root\\s*\\{[\\s\\S]*font-size:\\s*${scaled(15)};[\\s\\S]*line-height:\\s*1\\.55;`));
  assert.match(css, new RegExp(`\\.message-text\\s*\\{[\\s\\S]*font-size:\\s*${scaled(16)};[\\s\\S]*line-height:\\s*1\\.55;`));
  assert.match(css, new RegExp(`\\.composer textarea\\s*\\{[\\s\\S]*font-size:\\s*${scaled(15)};`));
  assert.match(css, new RegExp(`\\.rail button,[\\s\\S]*\\.sidebar-empty\\s*\\{[\\s\\S]*font-size:\\s*${scaled(14)};`));
});

test("readability layer keeps metadata at twelve pixels or larger at every breakpoint", () => {
  const sizes = fontSizes(css);
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((size) => size >= 12), `found undersized declarations: ${sizes.filter((size) => size < 12).join(", ")}`);
  assert.match(css, new RegExp(`\\.sidebar-chat-copy small,[\\s\\S]*\\.sidebar-worker small\\s*\\{[\\s\\S]*font-size:\\s*${scaled(12)};`));
  assert.match(css, new RegExp(`@media \\(max-width:\\s*740px\\)[\\s\\S]*\\.activity-summary\\s*\\{[\\s\\S]*font-size:\\s*${scaled(12)};`));
});

test("no application stylesheet can override text below the twelve pixel floor", () => {
  const undersized = stylesheets
    .filter(({ file }) => file !== "fonts.css")
    .flatMap(({ file, source }) => fontSizes(source).map((size) => ({ file, size })).filter(({ size }) => size < 12));
  assert.deepEqual(undersized, []);
});

test("every pixel font size follows the user's text scale", () => {
  const fixed = stylesheets.flatMap(({ file, source }) =>
    [...source.matchAll(/font(?:-size)?:\s*(?:[\d]+ )?([\d.]+px)/g)].map((match) => `${file}: ${match[0]}`));
  assert.deepEqual(fixed, []);
});

test("raw colours live only in tokens.css", () => {
  const colour = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
  const offenders = stylesheets
    .filter(({ file }) => file !== "tokens.css")
    .flatMap(({ file, source }) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // A var() fallback is only used if the token is missing; it is not a theme colour.
        .replace(/var\(--[\w-]+,[^()]*(?:\([^()]*\)[^()]*)*\)/g, "")
        .split("\n")
        .filter((line) => colour.test(line))
        .map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(offenders, []);
});

test("light and dark themes define the same tokens, and dark is the default", () => {
  const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  const block = (pattern: RegExp) => {
    const start = tokens.search(pattern);
    assert.ok(start >= 0, `missing ${pattern}`);
    const open = tokens.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
      if (tokens[i] === "{") depth++;
      if (tokens[i] === "}" && --depth === 0) return tokens.slice(open, i);
    }
    return "";
  };
  const names = (source: string) => new Set([...source.matchAll(/(--[\w-]+):/g)].map((match) => match[1]));
  const light = names(block(/:root\[data-theme="light"\]\s*\{/));
  const followOs = names(block(/:root:not\(\[data-theme\]\)\s*\{/));
  const dark = names(block(/^:root\s*\{/m));
  assert.match(tokens, /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme\]\)/);
  assert.match(block(/^:root\s*\{/m), /color-scheme:\s*dark;/);
  assert.deepEqual([...light].sort(), [...followOs].sort());
  for (const name of light) assert.ok(dark.has(name), `${name} has no dark value`);
});
