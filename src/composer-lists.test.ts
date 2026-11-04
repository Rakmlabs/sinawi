import test from "node:test";
import assert from "node:assert/strict";
import { continueListOnNewline, indentListLine, isImeComposing, listItemAt, replacedRange } from "./composer-lists";

test("a line becomes a list item once its marker is followed by a space", () => {
  assert.equal(listItemAt("1.", 2), undefined);
  assert.equal(listItemAt("-", 1), undefined);
  assert.deepEqual(
    (({ marker, ordered, number, empty }) => ({ marker, ordered, number, empty }))(listItemAt("1. ", 3)!),
    { marker: "1.", ordered: true, number: 1, empty: true },
  );
  assert.equal(listItemAt("- ", 2)?.ordered, false);
  assert.equal(listItemAt("* 항목", 4)?.empty, false);
  assert.equal(listItemAt("intro\n  - nested", 10)?.indent, "  ");
  assert.equal(listItemAt("1.5 liters", 3), undefined);
});

test("Shift+Enter continues Markdown lists and increments numbers", () => {
  assert.deepEqual(continueListOnNewline("1. foo", 6, 6), { value: "1. foo\n2. ", caret: 10 });
  assert.deepEqual(continueListOnNewline("1. a\n2. b", 9, 9), { value: "1. a\n2. b\n3. ", caret: 13 });
  assert.deepEqual(continueListOnNewline("9) foo", 6, 6), { value: "9) foo\n10) ", caret: 11 });
  assert.equal(continueListOnNewline("- foo", 5, 5)?.value, "- foo\n- ");
  assert.equal(continueListOnNewline("* foo", 5, 5)?.value, "* foo\n* ");
  assert.equal(continueListOnNewline("- [x] foo", 9, 9)?.value, "- [x] foo\n- [ ] ");
  assert.equal(continueListOnNewline("- [ ] foo", 9, 9)?.value, "- [ ] foo\n- [ ] ");
  assert.equal(continueListOnNewline("a\n  - foo", 9, 9)?.value, "a\n  - foo\n  - ");
  assert.equal(continueListOnNewline("1. a\n   1. b", 12, 12)?.value, "1. a\n   1. b\n   2. ");
});

test("Shift+Enter mid-line moves the rest into the new item, and a selection is replaced", () => {
  assert.deepEqual(continueListOnNewline("1. foobar", 6, 6), { value: "1. foo\n2. bar", caret: 10 });
  assert.equal(continueListOnNewline("1. a\n- b", 4, 4)?.value, "1. a\n2. \n- b");
  assert.deepEqual(continueListOnNewline("- abcd", 3, 5), { value: "- a\n- d", caret: 6 });
});

test("Shift+Enter on an empty top-level item ends the list", () => {
  // The marker goes and a blank line closes the list, so following text is not a lazy continuation of "b".
  assert.deepEqual(continueListOnNewline("1. a\n2. b\n3. ", 14, 14), { value: "1. a\n2. b\n\n", caret: 11 });
  assert.deepEqual(continueListOnNewline("- ", 2, 2), { value: "", caret: 0 });
  assert.deepEqual(continueListOnNewline("- [ ] ", 6, 6), { value: "", caret: 0 });
});

test("Shift+Enter on an empty nested item moves it out one level", () => {
  assert.deepEqual(continueListOnNewline("- a\n  - b\n  - ", 14, 14), { value: "- a\n  - b\n- ", caret: 12 });
  assert.deepEqual(continueListOnNewline("1. a\n   1. b\n   2. ", 19, 19), { value: "1. a\n   1. b\n2. ", caret: 16 });
});

test("Shift+Enter leaves non-list lines and the marker itself alone", () => {
  assert.equal(continueListOnNewline("hello", 5, 5), undefined);
  assert.equal(continueListOnNewline("-foo", 4, 4), undefined);
  assert.equal(continueListOnNewline("1.5 liters", 10, 10), undefined);
  assert.equal(continueListOnNewline("- foo", 1, 1), undefined);
});

test("Tab nests an item under its previous sibling, aligned to the sibling's text", () => {
  assert.deepEqual(indentListLine("- a\n- b", 7, false), { value: "- a\n  - b", caret: 9 });
  // `1. ` content starts at column 3: two spaces would not render as a sublist.
  assert.deepEqual(indentListLine("1. a\n2. b", 9, false), { value: "1. a\n   1. b", caret: 12 });
  // Numbering continues among existing children.
  assert.equal(indentListLine("1. a\n   1. x\n2. b", 17, false)?.value, "1. a\n   1. x\n   2. b");
  // Nesting twice goes one level at a time.
  assert.equal(indentListLine("- a\n  - b\n  - c", 15, false)?.value, "- a\n  - b\n    - c");
});

test("Tab cannot nest the first item, and keeps focus in the composer", () => {
  assert.deepEqual(indentListLine("- a", 3, false), { value: "- a", caret: 3 });
  assert.deepEqual(indentListLine("- a\n  - b", 9, false), { value: "- a\n  - b", caret: 9 });
  assert.equal(indentListLine("plain", 2, false), undefined);
});

test("Shift+Tab moves an item out to its parent's level and continues its numbering", () => {
  assert.deepEqual(indentListLine("- a\n    - b", 11, true), { value: "- a\n- b", caret: 7 });
  assert.equal(indentListLine("1. a\n   1. b", 12, true)?.value, "1. a\n2. b");
  assert.deepEqual(indentListLine("- a", 3, true), { value: "- a", caret: 3 });
});

test("indenting keeps the caret on the same character of the item's text", () => {
  // caret between "b" and "c" in "- bc"
  assert.deepEqual(indentListLine("- a\n- bc", 7, false), { value: "- a\n  - bc", caret: 9 });
  // caret inside the indentation lands at the start of the text
  assert.deepEqual(indentListLine("- a\n  - b", 4, true), { value: "- a\n- b", caret: 6 });
});

test("IME composition keys are ignored, including WebKit's keyCode 229 commit", () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isImeComposing({}), false);
});

test("replacedRange finds the single span an edit changed", () => {
  const apply = (before: string, after: string) => {
    const { start, end, text } = replacedRange(before, after);
    return before.slice(0, start) + text + before.slice(end);
  };
  for (const [before, after] of [["1. a", "1. a\n2. "], ["- a\n- b", "- a\n  - b"], ["1. a\n2. ", "1. a\n\n"], ["- a\n    - b", "- a\n- b"], ["", "x"], ["x", ""], ["aa", "aaa"]]) {
    assert.equal(apply(before, after), after);
  }
  assert.deepEqual(replacedRange("1. a", "1. a\n2. "), { start: 4, end: 4, text: "\n2. " });
});

/**
 * The composer flow typed quickly in a real browser: every edit is applied to the text and caret
 * before the next key, so each character lands at the caret the previous edit left.
 */
test("typing a mixed list with Shift+Enter, Tab and Shift+Tab, step by step", () => {
  let value = "";
  let caret = 0;
  const type = (text: string) => { value = value.slice(0, caret) + text + value.slice(caret); caret += text.length; };
  const shiftEnter = () => {
    const edit = continueListOnNewline(value, caret, caret);
    if (edit) ({ value, caret } = edit); else type("\n");
  };
  const tab = (outdent = false) => {
    const edit = indentListLine(value, caret, outdent);
    assert.ok(edit, "Tab on a list line is handled");
    ({ value, caret } = edit);
  };
  const at = (expected: string) => { assert.equal(value, expected); assert.equal(caret, expected.length); };

  type("할 일 정리"); shiftEnter(); at("할 일 정리\n");
  type("1. 첫째 항목"); shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. ");
  type("둘째 항목"); shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n3. ");
  tab(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. ");
  type("하위 항목"); shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n   2. ");
  tab(true); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n3. ");
  type("셋째 항목"); shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n3. 셋째 항목\n4. ");
  shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n3. 셋째 항목\n\n");
  type("- 불릿 하나"); shiftEnter(); at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n3. 셋째 항목\n\n- 불릿 하나\n- ");
  type("불릿 둘");
  at("할 일 정리\n1. 첫째 항목\n2. 둘째 항목\n   1. 하위 항목\n3. 셋째 항목\n\n- 불릿 하나\n- 불릿 둘");
});
