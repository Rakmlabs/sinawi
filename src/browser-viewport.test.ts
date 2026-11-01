import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deviceFrameStyle, deviceViewportMeta, emulationOf, emulationPayload, fitDevice, isViewportError, parseViewportArg, readViewport, serializeViewport, toggleViewport, viewportLabel, type ViewportChoice } from "./browser-viewport";

test("viewport presets and custom sizes", () => {
  assert.deepEqual(parseViewportArg("iphone"), { mode: "device", preset: "iphone", width: 390, height: 844 });
  assert.deepEqual(parseViewportArg("APP"), { mode: "device", preset: "iphone", width: 390, height: 844 });
  assert.deepEqual(parseViewportArg("tablet"), { mode: "device", preset: "tablet", width: 768, height: 1024 });
  const current: ViewportChoice = { mode: "device", preset: "iphone", width: 390, height: 844 };
  assert.deepEqual(parseViewportArg("web", current), { ...current, mode: "desktop" });
  assert.deepEqual(parseViewportArg("390x844"), { mode: "device", preset: "custom", width: 390, height: 844 });
  assert.deepEqual(parseViewportArg("412×915"), { mode: "device", preset: "custom", width: 412, height: 915 });
  const bad = parseViewportArg("nope");
  assert.equal(isViewportError(bad), true);
  if (isViewportError(bad)) assert.match(bad.error, /iphone/);
  const tiny = parseViewportArg("10x10");
  assert.equal(isViewportError(tiny), true);
  if (isViewportError(tiny)) assert.match(tiny.error, /200/);
});

test("mobile presets set a mobile user agent and touch", () => {
  const phone = emulationOf({ mode: "device", preset: "iphone", width: 390, height: 844 });
  assert.equal(phone.mobile, true);
  assert.equal(phone.touch, true);
  assert.match(phone.userAgent, /iPhone/);
  const pad = emulationOf({ mode: "device", preset: "tablet", width: 768, height: 1024 });
  assert.equal(pad.touch, true);
  assert.match(pad.userAgent, /iPad/);
  const narrow = emulationOf({ mode: "device", preset: "custom", width: 400, height: 800 });
  assert.equal(narrow.touch, true);
  assert.match(narrow.userAgent, /iPhone/);
  const medium = emulationOf({ mode: "device", preset: "custom", width: 800, height: 600 });
  assert.match(medium.userAgent, /iPad/);
  const wide = emulationOf({ mode: "device", preset: "custom", width: 1440, height: 900 });
  assert.equal(wide.mobile, false);
  assert.equal(wide.touch, false);
  const desk = emulationOf({ mode: "desktop", preset: "iphone", width: 390, height: 844 });
  assert.equal(desk.mobile, false);
  assert.equal(desk.userAgent, "");
});

test("toggle remembers the device and desktop is full width", () => {
  const phone = parseViewportArg("iphone");
  assert.equal(isViewportError(phone), false);
  if (isViewportError(phone)) return;
  const desk = toggleViewport(phone);
  assert.equal(desk.mode, "desktop");
  assert.equal(desk.preset, "iphone");
  assert.equal(desk.width, 390);
  assert.equal(toggleViewport(desk).mode, "device");
});

test("the device frame scales down only when the panel is smaller", () => {
  assert.equal(fitDevice(390, 844, 1200, 1000).scale, 1);
  const fit = fitDevice(390, 844, 300, 500);
  assert.ok(fit.scale < 1);
  assert.ok(fit.scale >= 0.3);
  assert.equal(fitDevice(390, 844, 90, 90).scale, 0.05);
  assert.equal(deviceFrameStyle(390, 844, 0.01).transform, "scale(0.05)");
  assert.equal(viewportLabel({ mode: "desktop", preset: "iphone", width: 390, height: 844 }), "데스크톱");
});

test("a scaled iPhone frame keeps a 390 CSS layout and paints the full visual box", () => {
  const frame = deviceFrameStyle(390, 844, 0.5);
  assert.equal(frame.width, "390px");
  assert.equal(frame.height, "844px");
  assert.equal(frame.visualWidth, 195);
  assert.equal(frame.visualHeight, 422);
  assert.equal(frame.transform, "scale(0.5)");
  assert.equal(frame.transformOrigin, "top left");
  assert.equal(frame.marginRight, "-195px");
  assert.equal(frame.marginBottom, "-422px");
  assert.equal(frame.transform.includes("zoom"), false);
  assert.equal(deviceViewportMeta(390), "width=390, initial-scale=1, minimum-scale=1, maximum-scale=1");
  const phone = emulationPayload({ mode: "device", preset: "iphone", width: 390, height: 844 });
  assert.equal(phone.width, 390);
  assert.equal(phone.height, 844);
  assert.equal(emulationPayload({ mode: "desktop", preset: "iphone", width: 390, height: 844 }).width, 0);
  const css = readFileSync(new URL("./browser.css", import.meta.url), "utf8");
  assert.match(css, /transform:\s*scale\(var\(--ao-zoom\)\)/);
  assert.match(css, /transform-origin:\s*top left/);
  assert.match(css, /margin-right:\s*calc\(var\(--ao-w\) \* \(var\(--ao-zoom\) - 1\)\)/);
  assert.doesNotMatch(css, /zoom:\s*var\(--ao-zoom\)/);
  assert.match(css, /var\(--font-mono\)/);
  assert.match(css, /var\(--text-body\)/);
  assert.match(css, /var\(--radius-rail\)/);
  assert.doesNotMatch(css, /Menlo/);
  assert.match(css, /button\.light[\s\S]*min-width:\s*28px/);
  assert.match(css, /button\.light::before[\s\S]*width:\s*13px/);
});

test("the last viewport choice round-trips", () => {
  const choice = parseViewportArg("768x1024");
  assert.equal(isViewportError(choice), false);
  if (isViewportError(choice)) return;
  assert.deepEqual(readViewport(serializeViewport(choice)), choice);
  assert.equal(readViewport("nope").mode, "desktop");
  assert.equal(readViewport(null).preset, "iphone");
  assert.deepEqual(readViewport(JSON.stringify({ mode: "device", preset: "iphone", width: 10, height: 10 })), { mode: "device", preset: "iphone", width: 390, height: 844 });
});
