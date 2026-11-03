import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CATEGORIES, isCategory, lastCategory, rememberCategory, searchSettings, settingsShortcut, SETTINGS_INDEX, stepCategory } from "./settings/settings-nav";
import { DEFAULT_TOAST_TYPES, parseToastTypes } from "./settings/notification-prefs";
import { Segmented, SettingRow, SwitchRow } from "./settings/controls";
import { SHORTCUTS } from "./onboarding-state";
import { dictionaries, getLang, setLang } from "./i18n";

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

test("settings categories: spec order, workspace categories included, last one remembered", () => {
  assert.deepEqual([...CATEGORIES], ["general", "appearance", "notifications", "shortcuts", "environment", "updates", "workspaces", "agents", "routing", "projects"]);
  for (const id of CATEGORIES) assert.ok(dictionaries.ko[`set.cat.${id}` as keyof typeof dictionaries.ko], id);
  const store = memory();
  assert.equal(lastCategory(store), "general");
  rememberCategory("routing", store);
  assert.equal(lastCategory(store), "routing");
  store.setItem("sinawi:settings:last", "bogus");
  assert.equal(lastCategory(store), "general");
  assert.equal(isCategory("agents"), true);
  assert.equal(isCategory("help"), false);
  assert.equal(stepCategory("general", -1), "projects");
  assert.equal(stepCategory("projects", 1), "general");
});

test("⌘, opens settings on macOS, Ctrl+, elsewhere; never while composing", () => {
  const key = (patch: Partial<KeyboardEvent> & { isComposing?: boolean; keyCode?: number }) => ({ key: ",", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });
  assert.equal(settingsShortcut(key({ metaKey: true }), true), true);
  assert.equal(settingsShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(settingsShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(settingsShortcut(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(settingsShortcut(key({ metaKey: true, isComposing: true }), true), false);
  assert.equal(settingsShortcut(key({ metaKey: true, keyCode: 229 }), true), false);
  assert.ok(SHORTCUTS.some(([keys, label]) => keys === "⌘," && label === "shortcut.settings"));
});

test("settings search matches labels, descriptions and synonyms in both languages", () => {
  const before = getLang();
  try {
    setLang("ko");
    assert.ok(searchSettings("테마").some((entry) => entry.id === "theme"));
    assert.ok(searchSettings("한도").some((entry) => entry.id === "quotaFallback"));
    assert.ok(searchSettings("컴퓨터 조작").some((entry) => entry.category === "environment"));
    assert.deepEqual(searchSettings("   "), []);
    assert.deepEqual(searchSettings("zzzz-nothing"), []);
    setLang("en");
    assert.ok(searchSettings("dark").some((entry) => entry.id === "theme"));
    assert.ok(searchSettings("routing rules").some((entry) => entry.id === "rules"));
    // Every indexed key exists in the dictionary.
    for (const entry of SETTINGS_INDEX) {
      for (const key of [entry.label, entry.section, entry.description].filter(Boolean)) assert.ok(dictionaries.en[key!], `${entry.id}: ${key}`);
    }
  } finally { setLang(before); }
});

test("toast preferences default to the previous critical types and ignore junk", () => {
  assert.deepEqual([...parseToastTypes(null)].sort(), [...DEFAULT_TOAST_TYPES].sort());
  const all = "[\"auth\",\"quota\",\"permission\",\"run-finished\",\"lead\",\"error\",\"info\"]";
  assert.deepEqual([...parseToastTypes("[\"quota\",\"nope\"]", all)], ["quota"]);
  assert.deepEqual([...parseToastTypes("[]", all)], []);
  // Saved before lead updates existed: those come on, the rest stays as chosen.
  assert.deepEqual([...parseToastTypes("[\"quota\"]")], ["quota", "lead"]);
  assert.deepEqual([...parseToastTypes("{oops")].sort(), [...DEFAULT_TOAST_TYPES].sort());
});

test("setting rows link label, description and switch; segmented is a radiogroup", () => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(SwitchRow, { id: "quotaFallback", label: "Auto switch", description: "When on…", value: true, save: () => {} }),
    createElement(SettingRow, { label: "Theme", modified: true, onReset: () => {}, children: ({ labelId }: { labelId: string }) => createElement(Segmented, { labelledBy: labelId, value: "dark", onChange: () => {}, options: [{ value: "system", label: "System" }, { value: "dark", label: "Dark" }] }) })));
  assert.match(html, /data-setting-id="quotaFallback"/);
  assert.match(html, /<label class="setting-row-label" id="([^"]+)-label" for="\1-control">/);
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-labelledby="[^"]+-label"[^>]*aria-describedby="[^"]+-desc"/);
  assert.match(html, /class="setting-row modified"/);
  assert.match(html, /aria-label="[^"]+"[^>]*><svg/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*>Dark/);
  assert.match(html, /role="radio" aria-checked="false" tabindex="-1"/);
});
