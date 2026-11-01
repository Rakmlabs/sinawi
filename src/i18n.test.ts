import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionaries, getLang, setLang, t, translatedMap, tx } from "./i18n";
import { applyAppearance, cleanFontName, defaultLang, fontStack, readAppearance } from "./appearance";
import { WindowHeader } from "./WindowHeader";
import { Beat } from "./Beat";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const tags = (text: string) => [...text.matchAll(/<\/?(?:b|strong)>/g)].map((match) => match[0]);

test("ko and en dictionaries share keys, placeholders and markup", () => {
  const ko = Object.keys(dictionaries.ko).sort();
  const en = Object.keys(dictionaries.en).sort();
  assert.deepEqual(en, ko);
  assert.ok(ko.length > 600, `expected the full UI dictionary, got ${ko.length} keys`);
  for (const key of ko as (keyof typeof dictionaries.ko)[]) {
    const source = dictionaries.ko[key];
    const english = dictionaries.en[key];
    assert.ok(english.trim(), `en.${key} is empty`);
    assert.deepEqual(placeholders(english), placeholders(source), `placeholders differ for ${key}`);
    assert.deepEqual(tags(english), tags(source), `markup differs for ${key}`);
    assert.doesNotMatch(english, /[가-힣]/, `en.${key} still contains Korean`);
  }
});

test("t interpolates, follows the current language and maps stay live", () => {
  const before = getLang();
  try {
    setLang("ko");
    const labels = translatedMap({ done: "status.done" });
    assert.equal(t("sessions.summary", { total: 3, running: 1 }), "전체 3개 · 진행 중 1개");
    assert.equal(labels.done, "완료");
    setLang("en");
    assert.equal(t("sessions.summary", { total: 3, running: 1 }), "3 total · 1 running");
    assert.equal(labels.done, "Done");
    assert.equal(renderToStaticMarkup(createElement("p", null, tx("ob.tools.note"))), "<p>Paste the install command into a terminal and run it. After installing, click <b>Check again</b> to update.</p>");
  } finally {
    setLang(before);
  }
});

test("desktop header renders the Sinawi wordmark and English labels", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const before = getLang();
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    setLang("en");
    const html = renderToStaticMarkup(createElement(WindowHeader, {}));
    assert.match(html, /<\/svg>Sinawi<\/span>/);
    assert.match(html, /New chat/);
    assert.doesNotMatch(html, /aria-label="Reload"/);
    assert.doesNotMatch(html, /[가-힣]/);
  } finally {
    setLang(before);
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("beat indicator is three decorative dots", () => {
  assert.equal(renderToStaticMarkup(createElement(Beat)), '<span class="beat" aria-hidden="true"><i></i><i></i><i></i></span>');
});

test("appearance preferences map onto the shared CSS contract", () => {
  assert.equal(defaultLang("ko-KR"), "ko");
  assert.equal(defaultLang("en-US"), "en");
  assert.equal(defaultLang("ja"), "en");
  const saved: Record<string, string> = { theme: "light", lang: "en", uiFont: "Inter", monoFont: "system", fontSize: "large" };
  const value = readAppearance((key) => saved[key] ?? null);
  assert.deepEqual(value, { theme: "light", lang: "en", uiFont: "Inter", monoFont: "system", fontSize: "large" });
  assert.equal(readAppearance(() => "bogus").theme, "system");
  assert.equal(readAppearance(() => "bogus").fontSize, "normal");
  assert.equal(cleanFontName(' "Bad";}font<x> '), "Badfontx");
  assert.equal(fontStack("default", "ui"), undefined);
  assert.match(fontStack("Inter", "ui")!, /^"Inter", /);

  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: (name: string, css: string) => props.set(name, css), removeProperty: (name: string) => props.delete(name) },
    removeAttribute: (name: string) => { attrs.delete(name); delete root.dataset.theme; },
    lang: "",
  };
  const before = getLang();
  try {
    applyAppearance(value, root as unknown as HTMLElement);
    assert.equal(root.dataset.theme, "light");
    assert.equal(root.lang, "en");
    assert.equal(props.get("--font-scale"), "1.1");
    assert.match(props.get("--font-ui")!, /"Inter"/);
    assert.match(props.get("--font-mono")!, /ui-monospace/);
    applyAppearance({ theme: "system", lang: "ko", uiFont: "default", monoFont: "default", fontSize: "normal" }, root as unknown as HTMLElement);
    assert.equal(root.dataset.theme, undefined);
    assert.equal(props.size, 0);
    assert.equal(getLang(), "ko");
  } finally {
    setLang(before);
  }
});
