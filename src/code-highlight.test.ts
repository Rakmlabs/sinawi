import test from "node:test";
import assert from "node:assert/strict";
import { highlightCode } from "./code-highlight";

const kinds = (code: string, language?: string) => highlightCode(code, language).filter((token) => token.kind !== "plain").map((token) => `${token.kind}:${token.text}`);

test("tokens always join back to the exact source", () => {
  const samples = ["const a = \"x\\\"y\"; // 끝\nlet b = 0x1f;", "def f():\n    return None  # 주석", "echo 'it''s' && ls\n", "/* open", "`unterminated"];
  for (const code of samples) assert.equal(highlightCode(code, "ts").map((token) => token.text).join(""), code);
  for (const code of samples) assert.equal(highlightCode(code, "sh").map((token) => token.text).join(""), code);
});

test("tints keywords, literals, strings, numbers and comments", () => {
  assert.deepEqual(kinds("const ok = true; // done", "ts"), ["keyword:const", "literal:true", "comment:// done"]);
  assert.deepEqual(kinds("x = 'a' + 42", "py"), ["string:'a'", "number:42"]);
  assert.deepEqual(kinds("npm test # 실행", "bash"), ["comment:# 실행"]);
  // `#` is not a comment in TypeScript; `//` is not one in shell.
  assert.deepEqual(kinds("a.#b", "ts"), []);
  assert.deepEqual(kinds("open https://x.dev", "sh"), []);
});

test("plain-text fences stay untinted", () => {
  assert.deepEqual(highlightCode("const x = 1", "text"), [{ kind: "plain", text: "const x = 1" }]);
  assert.deepEqual(highlightCode("", "ts"), []);
});
