import assert from "node:assert/strict";
import test from "node:test";
import { trimEvents } from "./events.js";
import { onlyWaiting } from "./orchestra.js";

const make = (types: string[]) => types.map((type, index) => ({ type: type as "tool" | "message", id: index }));

test("a session over the cap loses old tool lines before any message", () => {
  const events = make([...Array(4).fill("message"), ...Array(20).fill("tool"), ...Array(4).fill("message")]);
  trimEvents(events, 20);
  assert.equal(events.length, 20);
  assert.equal(events.filter((event) => event.type === "message").length, 8);
  assert.deepEqual(events.slice(0, 4).map((event) => event.id), [0, 1, 2, 3]);
});

test("the newest quarter keeps its tool lines, and messages go from the front only when nothing else is left", () => {
  const recent = make([...Array(10).fill("message"), ...Array(10).fill("tool")]);
  trimEvents(recent, 16);
  // 16 / 4 = 4 newest stay whole; 4 of the 6 older tool lines go.
  assert.equal(recent.filter((event) => event.type === "tool").length, 6);
  assert.equal(recent.at(-1)?.id, 19);

  const talk = make(Array(12).fill("message"));
  trimEvents(talk, 8);
  assert.deepEqual(talk.map((event) => event.id), [4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a worker report that only says it is waiting is not a result", () => {
  assert.equal(onlyWaiting("빌드 결과 알림을 기다립니다."), true);
  assert.equal(onlyWaiting("Waiting for the build to finish."), true);
  assert.equal(onlyWaiting("빌드 완료: exit 0. 배포 알림을 기다립니다."), false);
  assert.equal(onlyWaiting("상태: 부분 완료\n한 일: EAS 빌드를 올렸다\n증거: build id 123, 대기열 3번째\n남은 문제: 빌드가 끝나기를 기다립니다. " + "가".repeat(200)), false);
  assert.equal(onlyWaiting(""), false);
});
