import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatAttachmentBlock, type ComposerAttachment } from "./preview-attachments";
import { ImageGrid, MessageFold, UserMessageBody } from "./media-ui";
import { readFileSync } from "node:fs";
import {
  clusterGallery, formatBytes, galleryCells, isLongText, isUnfurlLink, localMediaRef, mediaUrl,
  parseAttachmentMessage, parseCsv, stepIndex, swipeDirection, trapFocusIndex, uploadFraction, uploadRejection,
} from "./viewer-model";

test("gallery keeps four cells and badges only the hidden count", () => {
  assert.equal(galleryCells([1, 2, 3, 4]).every((cell) => cell.more === 0), true);
  const five = galleryCells(["a", "b", "c", "d", "e"]);
  assert.equal(five.length, 4);
  assert.equal(five[3].more, 1);
  assert.equal(galleryCells(Array.from({ length: 8 }, (_, index) => index))[3].more, 4);
});

test("file viewer traps tab and restores the opener", () => {
  assert.equal(trapFocusIndex(0, -1, false), "dialog");
  assert.equal(trapFocusIndex(3, -1, false), 0);
  assert.equal(trapFocusIndex(3, -1, true), 2);
  assert.equal(trapFocusIndex(3, 2, false), 0);
  assert.equal(trapFocusIndex(3, 0, true), 2);
  assert.equal(trapFocusIndex(3, 1, false), null);
  assert.equal(trapFocusIndex(1, 0, true), 0);
  const source = readFileSync(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  const pdf = readFileSync(new URL("./PdfCanvas.tsx", import.meta.url), "utf8");
  assert.match(source, /trapFocusIndex/);
  assert.match(source, /isConnected/);
  assert.match(source, /Escape/);
  assert.match(source, /이미지를 표시하지 못했습니다/);
  assert.doesNotMatch(source, /onError=\{\(\) => \{\}\}/);
  assert.match(pdf, /외부로 열기/);
  assert.match(pdf, /viewer-pdf-frame/);
  assert.match(pdf, /role="alert"/);
});

test("lightbox index wraps and swipes ignore vertical drags", () => {
  assert.equal(stepIndex(0, -1, 4), 3);
  assert.equal(stepIndex(3, 1, 4), 0);
  assert.equal(swipeDirection(-80, 10), 1);
  assert.equal(swipeDirection(80, 10), -1);
  assert.equal(swipeDirection(-80, 90), 0);
  assert.equal(swipeDirection(10, 0), 0);
});

test("file sizes, long text, upload limits and media urls", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(undefined), "");
  assert.equal(isLongText("짧음"), false);
  assert.equal(isLongText("x".repeat(3501)), true);
  assert.match(uploadRejection({ name: "big.mov", size: 81 * 1024 * 1024 }) ?? "", /80MB/);
  assert.equal(uploadRejection({ name: "ok.png", size: 100 }), undefined);
  assert.equal(uploadFraction(50, 0), 0);
  assert.equal(uploadFraction(25, 100), 0.25);
  assert.equal(mediaUrl("s 1", "a b.pdf", { download: true }), "/api/sessions/s%201/file?path=a+b.pdf&download=1");
  assert.equal(mediaUrl(undefined, "https://cdn.example/a.png"), "https://cdn.example/a.png");
});

test("local file links become chips and remote or extensionless links do not", () => {
  assert.equal(localMediaRef("/safe")?.kind, undefined);
  assert.equal(localMediaRef("https://example.com/a.pdf"), undefined);
  assert.equal(localMediaRef("javascript:alert(1)"), undefined);
  assert.equal(localMediaRef("docs/보고서.pdf", "보고서")?.kind, "pdf");
  assert.equal(isUnfurlLink("https://example.com/a", "https://example.com/a"), true);
  assert.equal(isUnfurlLink("https://example.com/docs", "문서"), false);
});

test("consecutive markdown images cluster and fenced examples stay put", () => {
  const markdown = ["앞", "", "![하나](a.png)", "", "![둘](b.png)", "![셋](c.png)", "", "뒤", "", "```md", "![그대로](d.png)", "```"].join("\n");
  const clustered = clusterGallery(markdown);
  assert.match(clustered, /orchestra-gallery/);
  assert.match(clustered, /"src":"a.png"/);
  assert.match(clustered, /```md\n!\[그대로\]\(d\.png\)\n```/);
  assert.match(clustered, /\n뒤/);
});

test("attachment fences become images and file chips instead of raw prompt text", () => {
  const image: ComposerAttachment = { id: "1", kind: "image", label: "화면.png", screenshotPath: "/tmp/work/화면.png" };
  const file: ComposerAttachment = { id: "2", kind: "file", label: "견적.pdf", screenshotPath: "/tmp/work/견적.pdf" };
  const text = `이것 봐\n\n${formatAttachmentBlock([image, file])}`;
  const parsed = parseAttachmentMessage(text);
  assert.equal(parsed.body, "이것 봐");
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.files[0]?.kind, "pdf");
  assert.equal(parsed.files[0]?.name, "견적.pdf");
  const html = renderToStaticMarkup(createElement(UserMessageBody, { text }));
  assert.doesNotMatch(html, /orchestra-attachments/);
  assert.match(html, /file-chip/);
  assert.match(html, /견적\.pdf/);
});

test("image grid reserves cells and shows the hidden count", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ path: `shot-${index}.png`, name: `shot ${index}`, kind: "image" as const }));
  const html = renderToStaticMarkup(createElement(ImageGrid, { items }));
  assert.equal((html.match(/<img /g) ?? []).length, 4);
  assert.match(html, />\+2</);
  assert.match(html, /width="320"/);
});

test("long assistant output offers a fold and short output does not", () => {
  const long = renderToStaticMarkup(createElement(MessageFold, { text: "나".repeat(3600) }, "본문"));
  assert.match(long, /더 보기/);
  assert.match(long, /message-fold-clip/);
  const short = renderToStaticMarkup(createElement(MessageFold, { text: "짧음" }, "본문"));
  assert.doesNotMatch(short, /더 보기/);
});

test("csv quotes and row cap", () => {
  const rows = parseCsv('이름,메모\n"홍, 길동","그는 ""안녕""이라 했다"\n', 10);
  assert.deepEqual(rows[0], ["이름", "메모"]);
  assert.deepEqual(rows[1], ["홍, 길동", "그는 \"안녕\"이라 했다"]);
});
