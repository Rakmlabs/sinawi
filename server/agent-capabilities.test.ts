import assert from "node:assert/strict";
import test from "node:test";
import { capabilityCatalog } from "./agent-capabilities.js";

test("the lead sees every allowed CLI, what it can do, and who is not on the team yet", () => {
  const catalog = capabilityCatalog(["claude", "codex", "grok"], ["grok", "codex"]);
  assert.match(catalog, /누구에게 맡길지는 당신이 판단합니다/);
  assert.match(catalog, /- claude \(팀에 없음: 위임하면 앱이 워커를 만든다\): .*\/design.*disable-model-invocation/);
  assert.match(catalog, /frontend-design.*impeccable.*canvas-design.*web-artifacts-builder/);
  assert.match(catalog, /HTML.*목업/);
  assert.match(catalog, /사용자.*터미널.*선택.*수동/);
  assert.match(catalog, /- grok \(지금 팀에 있음\): .*이미지·영상 생성/);
  // Facts, not keyword routing.
  assert.doesNotMatch(catalog, /이면 claude|디자인이면/);
  assert.equal(capabilityCatalog([], []), "");
  assert.doesNotMatch(capabilityCatalog(["codex"], ["codex"]), /- claude/);
});
