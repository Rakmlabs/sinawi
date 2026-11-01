import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentLabel, displayUrl, formatAttachmentBlock, promptWithAttachments, type ComposerAttachment } from "./preview-attachments";
import { browserShortcut, globalBrowserShortcut } from "./browser-shortcuts";

const element: ComposerAttachment = {
  id: "a", kind: "element", label: "<SaveButton>", screenshotPath: "/tmp/e.png", viewportPath: "/tmp/v.png", preview: "data:image/png;base64,AAAA",
  element: {
    url: "http://localhost:3000/settings", comment: "더 진하게", selector: "#app > button.save", tag: "button", text: "저장",
    outerHTML: "<button class=\"save\">저장 ```</button>", styles: { color: "rgb(0, 0, 0)" }, rect: { x: 10, y: 20, width: 100, height: 40 },
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 2 }, react: { name: "SaveButton", chain: ["SaveButton", "Settings"], source: "src/Save.tsx:12" },
  },
};

test("formatAttachmentBlock includes everything the agent needs", () => {
  const block = formatAttachmentBlock([element]);
  assert.match(block, /^```orchestra-attachments\n/);
  assert.match(block, /메모: 더 진하게/);
  assert.match(block, /selector: #app > button\.save/);
  assert.match(block, /React 컴포넌트: SaveButton ← Settings/);
  assert.match(block, /소스: src\/Save\.tsx:12/);
  assert.match(block, /x=10 y=20 100×40px/);
  assert.match(block, /요소 캡처: \/tmp\/e\.png/);
  assert.match(block, /전체 화면 캡처: \/tmp\/v\.png/);
  assert.ok(!block.includes("data:image"), "thumbnails are never sent");
  assert.equal(block.match(/```/g)?.length, 2, "inner fences are neutralized");
});

test("promptWithAttachments supplies a default request", () => {
  assert.match(promptWithAttachments("", [element]), /^첨부한 요소를 확인해 줘\./);
  assert.equal(promptWithAttachments("hi", []), "hi");
});

test("displayUrl maps proxy urls back to the dev server", () => {
  assert.equal(displayUrl("http://127.0.0.1:55555/a?b", "http://127.0.0.1:55555", "http://localhost:3000"), "http://localhost:3000/a?b");
  assert.equal(attachmentLabel({ tag: "div", selector: "main > div.card", comment: "" }), "div.card");
});

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test("browser shortcuts", () => {
  assert.deepEqual(browserShortcut(k("t", { metaKey: true })), { type: "new-tab" });
  assert.deepEqual(browserShortcut(k("T", { metaKey: true, shiftKey: true })), { type: "reopen-tab" });
  assert.deepEqual(browserShortcut(k("w", { metaKey: true })), { type: "close-tab" });
  assert.deepEqual(browserShortcut(k("l", { metaKey: true })), { type: "focus-url" });
  assert.deepEqual(browserShortcut(k("r", { metaKey: true })), { type: "reload" });
  assert.deepEqual(browserShortcut(k("Tab", { ctrlKey: true })), { type: "next-tab" });
  assert.deepEqual(browserShortcut(k("Tab", { ctrlKey: true, shiftKey: true })), { type: "prev-tab" });
  assert.deepEqual(browserShortcut(k("3", { metaKey: true })), { type: "select-tab", index: 2 });
  assert.deepEqual(browserShortcut(k("9", { metaKey: true })), { type: "select-tab", index: -1 });
  assert.equal(browserShortcut(k("t")), undefined);
  assert.deepEqual(globalBrowserShortcut(k("B", { metaKey: true, shiftKey: true, code: "KeyB" })), { type: "toggle-panel" });
  assert.deepEqual(globalBrowserShortcut(k("C", { metaKey: true, shiftKey: true, code: "KeyC" })), { type: "toggle-picker" });
  assert.equal(globalBrowserShortcut(k("c", { metaKey: true })), undefined);
});
