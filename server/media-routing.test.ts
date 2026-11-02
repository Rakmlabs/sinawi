import assert from "node:assert/strict";
import test from "node:test";
import { mediaRouteRequired } from "./media-routing.js";

test("media route detection recognizes all current and legacy media ids and custom rule keywords", () => {
  for (const id of ["media-generation", "marketing-shorts", "video", "image", "image-text", "image-visual"]) {
    assert.equal(mediaRouteRequired("campaign asset", [{ id, keywords: ["asset"] }]), true);
    assert.equal(mediaRouteRequired("campaign asset", [{ id, keywords: ["/^campaign/i"] }]), true);
    assert.equal(mediaRouteRequired("unrelated", [{ id, keywords: ["asset"] }]), false);
  }
  assert.equal(mediaRouteRequired("campaign asset", [{ id: "coding", keywords: ["asset"] }]), false);
  assert.equal(mediaRouteRequired("이미지 만들어줘", []), true);
});

test("checking the screen with a screenshot is not a media request", () => {
  const rules = [{ id: "image-text", keywords: ["스크린샷", "글자"] }];
  for (const prompt of ["texedit을 열고 hello sinawi라고 입력해줘 끝나면 스크린샷으로 확인해줘 저장은 하지마", "페이지 열고 스크린샷 찍어서 보여줘", "결과를 캡처로 남겨줘"]) {
    assert.equal(mediaRouteRequired(prompt, rules), false, prompt);
    assert.equal(mediaRouteRequired(prompt, []), false, prompt);
  }
  assert.equal(mediaRouteRequired("앱스토어 스크린샷 만들어줘", rules), true);
  assert.equal(mediaRouteRequired("앱스토어 스크린샷 만들어줘", []), true);
});
