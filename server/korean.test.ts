import assert from "node:assert/strict";
import test from "node:test";
import { josa, withJosa } from "./korean.js";

test("particles follow the last sound of the word", () => {
  assert.equal(withJosa("담당", "이/가"), "담당이");
  assert.equal(withJosa("백엔드", "이/가"), "백엔드가");
  assert.equal(withJosa("채팅", "을/를"), "채팅을");
  assert.equal(withJosa("워크스페이스", "을/를"), "워크스페이스를");
  assert.equal(withJosa("일정", "은/는"), "일정은");
  assert.equal(withJosa("그룹", "과/와"), "그룹과");
  assert.equal(withJosa("파일", "으로/로"), "파일로", "ㄹ takes 로");
  assert.equal(withJosa("폴더", "으로/로"), "폴더로");
  assert.equal(withJosa("작업공간", "으로/로"), "작업공간으로");
});

test("quotes, a trailing (id) and non-Korean words are read the way they sound", () => {
  assert.equal(withJosa("담당 '백엔드'", "이/가"), "담당 '백엔드'가");
  assert.equal(withJosa("채팅 'API 정리' (3f2a9c1e)", "을/를"), "채팅 'API 정리' (3f2a9c1e)를");
  assert.equal(withJosa("외부 AI", "이/가"), "외부 AI가");
  assert.equal(withJosa("Claude", "으로/로"), "Claude로");
  assert.equal(withJosa("Grok", "으로/로"), "Grok으로");
  assert.equal(withJosa("Codex", "이/가"), "Codex가");
  assert.equal(withJosa("LLM", "이/가"), "LLM이");
  assert.equal(withJosa("버전 3", "이/가"), "버전 3이");
  assert.equal(withJosa("버전 2", "이/가"), "버전 2가");
  assert.equal(josa("???", "이/가"), "이(가)", "nothing to judge by");
  assert.equal(josa("", "으로/로"), "(으)로");
});
