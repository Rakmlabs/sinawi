import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { APP_TOOLS } from "./app-tools.js";
import { EN_SUMMARIES, expectedAiDocs, groupTools, renderToolTables, replaceBetweenMarkers, TOOLS_END, TOOLS_START } from "./ai-docs.js";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

test("the AI docs' tool tables match the registry (run `npm run docs:ai` after changing server/app-tools.ts)", async () => {
  for (const doc of await expectedAiDocs(root)) {
    assert.equal(doc.current, doc.expected, `${doc.path} is out of date: run npm run docs:ai`);
  }
});

test("every registry tool is listed once, in a named section, with its approval flag", async () => {
  const source = await readFile(`${root}/server/app-tools.ts`, "utf8");
  const grouped = groupTools(source);
  assert.equal(grouped.length, APP_TOOLS.length);
  for (const lang of ["en", "ko"] as const) {
    const block = renderToolTables(source, lang);
    for (const tool of APP_TOOLS) {
      const rows = block.split("\n").filter((line) => line.startsWith(`| \`${tool.name}\` |`));
      assert.equal(rows.length, 1, `${lang}: ${tool.name} appears once`);
      const approval = lang === "ko" ? "**필요**" : "**yes**";
      assert.equal(rows[0].includes(approval), tool.risk === "approval", `${lang}: ${tool.name} approval flag`);
    }
  }
  for (const tool of APP_TOOLS) assert.ok(EN_SUMMARIES[tool.name], `${tool.name} has an English summary`);
});

test("only the marked part of a doc is replaced", () => {
  const doc = `head\n${TOOLS_START}\nold\n${TOOLS_END}\ntail\n`;
  assert.equal(replaceBetweenMarkers(doc, "new"), `head\n${TOOLS_START}\nnew\n${TOOLS_END}\ntail\n`);
  assert.throws(() => replaceBetweenMarkers("no markers", "new"), /markers/u);
});
