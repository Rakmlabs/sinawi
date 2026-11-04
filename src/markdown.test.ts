import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

test("renders GFM blocks, tables, task lists, and copyable fenced code", () => {
  const markdown = [
    "## 작업 결과",
    "",
    "**성공하고 `검증된` 결과**이며 `npm test`를 실행했습니다.",
    "",
    "- 첫 번째 변경",
    "- [문서](https://example.com/docs)",
    "",
    "1. 확인",
    "2. 완료",
    "",
    "> 안전하게 렌더링합니다.",
    "",
    "| 항목 | 상태 |",
    "| --- | --- |",
    "| 테스트 | 완료 |",
    "",
    "- [x] 검증",
    "",
    "```ts",
    "const result = true;",
    "```",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { text: markdown }));

  assert.match(html, /^<div class="markdown">/);
  assert.match(html, /<h2>작업 결과<\/h2>/);
  assert.match(html, /<strong>성공하고 <code>검증된<\/code> 결과<\/strong>이며 <code>npm test<\/code>/);
  assert.match(html, /<li>첫 번째 변경<\/li>/);
  assert.match(html, /<a href="https:\/\/example.com\/docs" rel="noreferrer" title="https:\/\/example.com\/docs">문서<\/a>/);
  assert.match(html, /<li>확인<\/li>/);
  assert.match(html, /<blockquote>[\s\S]*안전하게 렌더링합니다/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /class="code-block"/);
  assert.match(html, /class="code-language">ts<\/span>/);
  assert.match(html, /aria-label="코드 복사"/);
  assert.match(html, /<code class="language-ts"><span class="tok-keyword">const<\/span> result = <span class="tok-literal">true<\/span>;\n<\/code>/);
});

test("escapes HTML and does not link unsafe protocols", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    text: "<script>alert('x')</script>\n\n[누르지 마세요](javascript:alert(1)) [로컬](/safe)",
  }));

  assert.match(html, /&lt;script&gt;alert\(&#x27;x&#x27;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href=""|href="javascript:/);
  assert.match(html, /누르지 마세요/);
  assert.match(html, /<a href="\/safe" rel="noreferrer" title="\/safe">로컬<\/a>/);
});

test("external links do not replace the app and raw HTML stays inert", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    text: "[문서](https://example.com) [CDN](//cdn.example.com/file)\n\n<div>내용</div>",
  }));
  // target="_blank" does nothing in the app's webview: clicks go through WebLink (in-app or default browser).
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 0);
  assert.equal((html.match(/<a href=/g) ?? []).length, 2);
  assert.match(html, /&lt;div&gt;내용&lt;\/div&gt;/);
  assert.doesNotMatch(html, /<div>내용<\/div>/);
});
