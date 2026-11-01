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
