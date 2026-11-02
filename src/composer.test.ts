import test from "node:test";
import assert from "node:assert/strict";
import { fileToken, handlesCompletionKey, historyEntries, historyStep, matchingSkills, numberedOptions, recentPaths, slashToken } from "./composer";

test("slash suggestions only open for a command at the start", () => {
  assert.deepEqual(slashToken("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(slashToken("/rev 뒤의 내용", 4), { start: 0, end: 4, query: "rev" });
  assert.equal(slashToken("검토 /rev", 7), undefined);
  assert.equal(slashToken("/Users/me", 9), undefined);
  assert.equal(slashToken("https://", 8), undefined);
  assert.equal(slashToken("/review ", 8), undefined);
});

test("file suggestions follow the active at token", () => {
  const text = "검토 @src/ma";
  assert.deepEqual(fileToken(text, text.length), { start: 3, end: text.length, query: "src/ma" });
  assert.deepEqual(fileToken("@", 1), { start: 0, end: 1, query: "" });
  assert.equal(fileToken("mail@example.com", 16), undefined);
  assert.equal(fileToken("@src/main.tsx done", 18), undefined);
});

test("ordered choices parse from assistant markdown without consuming ordinary lists", () => {
  assert.deepEqual(numberedOptions("Choose:\n1. Fast path\n2) Safer path\n3. Custom path"), ["Fast path", "Safer path", "Custom path"]);
  assert.deepEqual(numberedOptions("1. only one item"), []);
  assert.deepEqual(numberedOptions("10. outside keyboard range\n11. another"), []);
  assert.deepEqual(numberedOptions("1. First\n3. Third"), []);
  assert.deepEqual(numberedOptions("```text\n1. example\n2. example\n```"), []);
  assert.deepEqual(numberedOptions("Steps:\n1. Open settings\n2. Save changes\n\nChoose:\n1. Fast path\n2. Safe path"), ["Fast path", "Safe path"]);
  assert.deepEqual(numberedOptions("1. First choice\n2. Second choice\n\nLater note without options"), ["First choice", "Second choice"]);
});

test("completion navigation leaves Shift+Enter available for a newline", () => {
  assert.equal(handlesCompletionKey("Enter", false), true);
  assert.equal(handlesCompletionKey("Enter", true), false);
  assert.equal(handlesCompletionKey("Tab", true), true);
  assert.equal(handlesCompletionKey("ArrowDown", true), true);
});

test("history puts current chat first, deduplicates globally, and restores the draft", () => {
  const entries = historyEntries(["local latest", "shared", "local latest"], ["global latest", "shared", "older"]);
  assert.deepEqual(entries, ["local latest", "shared", "global latest", "older"]);
  assert.deepEqual(historyStep(entries, -1, "draft", -1), { index: 0, value: "local latest", draft: "draft" });
  assert.deepEqual(historyStep(entries, 1, "draft", 0), { index: -1, value: "draft", draft: "draft" });
  assert.deepEqual(historyStep(entries, -1, "draft", 99), { index: 3, value: "older", draft: "draft" });
});

test("skill filtering searches Korean descriptions and case insensitive names", () => {
  const skills = [{ id: "1", name: "Review", source: "local", description: "코드 검토" }];
  assert.deepEqual(matchingSkills(skills, "검토"), skills);
  assert.deepEqual(matchingSkills(skills, "REVIEW"), skills);
  assert.deepEqual(matchingSkills(skills, "missing"), []);
});

test("recent folders reject malformed persisted entries and limit history", () => {
  assert.deepEqual(recentPaths(["/a", 1, null, "/a", "relative", "/b"]), ["/a", "/b"]);
  assert.deepEqual(recentPaths({}), []);
  assert.equal(recentPaths(Array.from({ length: 12 }, (_, i) => `/path${i}`)).length, 8);
});

test("favorites can retain twenty validated paths independently of recent history", () => {
  const folders = Array.from({ length: 24 }, (_, i) => `/work/project-${i}`);
  assert.equal(recentPaths(folders, 20).length, 20);
  assert.equal(recentPaths(folders).length, 8);
});

test("a running composer stays open and sends a draft instead of stopping", async () => {
  const { composerAction, composerLocked } = await import("./composer");
  assert.equal(composerAction(true, false), "stop");
  assert.equal(composerAction(true, true), "send");
  assert.equal(composerAction(false, false), "send");
  assert.equal(composerLocked(true, true), false);
  assert.equal(composerLocked(false, true), true);
});

test("usage command is exact and does not consume ordinary prompts or skills", async () => {
  const { isUsageCommand } = await import("./composer");
  assert.equal(isUsageCommand("  /usage \n"), true);
  assert.equal(isUsageCommand("/usage explain"), false);
  assert.equal(isUsageCommand("show /usage"), false);
});

test("numbered choices support Markdown lists separated by blank lines", () => {
  assert.deepEqual(numberedOptions("선택하세요:\n1. 빠르게 진행\n\n2. 검토 후 진행\n\n3) 직접 지정"), ["빠르게 진행", "검토 후 진행", "직접 지정"]);
});

test("slash menu: name matches rank first, plugin skills match their last segment, commands are built in", async () => {
  const { matchingSkills, matchingCommands, slashCommandOf } = await import("./composer");
  const skill = (name: string, description = "") => ({ id: name, name, description, source: "Claude" }) as never;
  const skills = [skill("docx", "for frontend docs"), skill("oh-my-claudecode:ask"), skill("frontend-design"), skill("my-frontend")];
  assert.deepEqual(matchingSkills(skills, "front").map((item: { name: string }) => item.name), ["frontend-design", "my-frontend", "docx"]);
  assert.deepEqual(matchingSkills(skills, "ask").map((item: { name: string }) => item.name), ["oh-my-claudecode:ask"]);
  assert.deepEqual(matchingCommands("c"), ["clear", "compact"]);
  assert.deepEqual(matchingCommands(""), ["clear", "compact", "usage"]);
  assert.equal(slashCommandOf(" /compact\n"), "compact");
  assert.equal(slashCommandOf("/compact now"), undefined);
  assert.equal(slashCommandOf("/frontend-design"), undefined);
});
