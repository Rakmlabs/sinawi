import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark } from "./AgentMark";

for (const [agent, file, name] of [["codex", "codex", "Codex"], ["claude", "claude-color", "Claude"], ["grok", "grok", "Grok Build"]]) {
  test(`${name} renders its downloaded brand mark with an accessible name`, () => {
    const html = renderToStaticMarkup(createElement(AgentMark, { agent, size: "small" }));
    assert.ok(html.includes(`aria-label="${name}"`));
    assert.ok(html.includes(`${file}.svg`));
    assert.match(html, /<img[^>]+alt=""/);
    const svg = readFileSync(new URL(`./assets/agents/${file}.svg`, import.meta.url), "utf8");
    assert.match(svg, /<svg/);
    assert.match(svg, /<path/);
    assert.match(svg, new RegExp(`<title>${agent === "grok" ? "Grok" : name}</title>`));
    assert.doesNotMatch(html, /openai\.svg|agent-mark-fallback/);
  });
}

test("unknown agents retain an accessible text fallback instead of borrowing another logo", () => {
  const html = renderToStaticMarkup(createElement(AgentMark, { agent: "system" }));
  assert.match(html, /aria-label="system"/);
  assert.match(html, /agent-mark-fallback">sy</);
  assert.doesNotMatch(html, /<img/);
});
