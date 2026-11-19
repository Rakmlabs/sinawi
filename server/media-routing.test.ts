import assert from "node:assert/strict";
import test from "node:test";
import { mediaRouteRequired, namedAgent, nonRasterRequest } from "./media-routing.js";

test("a named agent is detected and keeps media prompts off the Grok route", () => {
  for (const [prompt, agent] of [
    ["그냥 전부 클로드로 해", "claude"], ["Claude로 만들어", "claude"], ["claude code로 해줘", "claude"],
    ["codex로 해", "codex"], ["코덱스한테 맡겨", "codex"], ["use codex for this image", "codex"],
    ["그록으로 이미지 만들어", "grok"], ["Grok Build로 해", "grok"],
  ] as const) assert.equal(namedAgent(prompt), agent, prompt);
  for (const prompt of ["썸네일 이미지를 만들어줘", "codex review 결과 정리", "클로드 코드 문서를 읽어줘"]) assert.equal(namedAgent(prompt), undefined, prompt);

  assert.equal(mediaRouteRequired("썸네일 이미지를 만들어줘", []), true);
  assert.equal(mediaRouteRequired("썸네일 이미지를 클로드로 만들어줘", []), false);
  assert.equal(mediaRouteRequired("codex로 로고 시안 만들어", [{ id: "image", keywords: ["로고"] }]), false);
  assert.equal(mediaRouteRequired("그록으로 썸네일 이미지 만들어", []), true);
});

test("SVG, HTML/CSS and icon-in-browser requests are not raster media", () => {
  const reported = "카드디자인 안에 들어갈 아이콘의 디자인을 시안 여러 개 만들어서 브라우저에 탭 하나 띄워서 보여줘. 시안은 5개 정도. 리퀴드 글래스 스타일… 그냥 전부 클로드로 해, 이미지를 만들든 svg든 뽑아봐";
  for (const prompt of [reported, "SVG/HTML 아이콘 시안 5개를 만들어 브라우저 탭에 띄워", "배경 이미지를 CSS gradient로 바꿔줘", "UI 컴포넌트에 들어갈 그림자 스타일"]) {
    assert.equal(nonRasterRequest(prompt), true, prompt);
    assert.equal(mediaRouteRequired(prompt, []), false, prompt);
  }
  for (const prompt of ["앱 아이콘 PNG 이미지를 생성해줘", "광고 영상을 HTML 랜딩에 넣을 수 있게 만들어줘", "실사 사진 느낌의 배경"]) {
    assert.equal(mediaRouteRequired(prompt, []), true, prompt);
  }
});

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
