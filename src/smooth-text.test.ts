import assert from "node:assert/strict";
import test from "node:test";
import { keptPrefix, nextRevealLength } from "./smooth-text";

test("a backlog drains at a pace that grows with its size and always moves", () => {
  const text = "안녕하세요. 오늘 작업을 시작합니다.";
  assert.equal(nextRevealLength(0, text, 1), 1, "at least one character per frame");
  const small = nextRevealLength(0, text, 16) - 0;
  const big = nextRevealLength(0, text.repeat(20), 16) - 0;
  assert.ok(big > small * 5, "a larger backlog reveals faster");
  assert.equal(nextRevealLength(0, text, 10_000), text.length, "a long pause shows everything");
  assert.equal(nextRevealLength(text.length, text, 16), text.length);
});

test("an emoji is never split and a replaced draft keeps only the shared start", () => {
  const text = "a😀b";
  assert.equal(nextRevealLength(0, text, 1), 1);
  assert.equal(nextRevealLength(1, text, 1), 3, "both halves of the surrogate pair together");
  assert.equal(keptPrefix("hello wor", "hello world"), 9);
  assert.equal(keptPrefix("hello wor", "help"), 3);
});
