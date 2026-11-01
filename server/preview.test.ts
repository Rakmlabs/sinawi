import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { injectPicker, isLoopbackTarget, normalizeAddress, parseLsof, PreviewProxies } from "./preview.js";
import { cssSelectorFor, trimOuterHtml } from "./preview-selector.js";
import { pickerScript } from "./preview-picker.js";
import { mediaRouteRequired, stripPreviewAttachments } from "./media-routing.js";

test("normalizeAddress handles ports, hosts and search", () => {
  assert.equal(normalizeAddress("3000"), "http://localhost:3000/");
  assert.equal(normalizeAddress(":5173/app"), "http://localhost:5173/app");
  assert.equal(normalizeAddress("localhost:8080/x"), "http://localhost:8080/x");
  assert.equal(normalizeAddress("example.com"), "https://example.com");
  assert.match(normalizeAddress("리액트 훅"), /^https:\/\/www\.google\.com\/search\?q=/);
});

test("only loopback http targets are proxied", () => {
  assert.ok(isLoopbackTarget("http://localhost:3000"));
  assert.ok(isLoopbackTarget("http://127.0.0.1:5173/a"));
  assert.ok(isLoopbackTarget("http://app.localhost:3000"));
  assert.equal(isLoopbackTarget("https://example.com"), undefined);
  assert.equal(isLoopbackTarget("http://192.168.0.2:3000"), undefined);
});

test("injectPicker puts the script at the start of head", () => {
  assert.match(injectPicker("<html><head><title>x</title></head></html>"), /<head><script src="\/__orchestra\/picker.js"><\/script><title>/);
  assert.match(injectPicker("<div>x</div>"), /^<script src/);
});

test("picker script is valid JavaScript", () => {
  const source = pickerScript();
  assert.doesNotThrow(() => new Function(source));
  assert.ok(!source.includes("__CSS_SELECTOR__"));
  assert.match(source, /var\(--font-sans\)/);
  assert.match(source, /var\(--font-mono\)/);
  assert.match(source, /var\(--text-body\)/);
  assert.match(source, /var\(--radius-control\)/);
  assert.doesNotMatch(source, /Menlo/);
  assert.doesNotMatch(source, /-apple-system,'Apple SD Gothic Neo'/);
});

test("parseLsof keeps dev-server listeners only", () => {
  const out = "p1\ncnode\nn*:3000\nn127.0.0.1:3001\np2\ncControlCe\nn*:7000\np3\ncpython3.12\nn[::1]:8000\np4\ncnode\nn*:3000\n";
  assert.deepEqual(parseLsof(out, new Set([3001])).map((p) => p.port), [3000, 8000]);
});

type Fake = { nodeType: 1; tagName: string; id: string; classList: string[]; attrs: Record<string, string>; parentElement: Fake | null; children: Fake[]; getAttribute(name: string): string | null };
function el(tag: string, opts: { id?: string; cls?: string[]; attrs?: Record<string, string> } = {}, kids: Fake[] = []): Fake {
  const node: Fake = { nodeType: 1, tagName: tag.toUpperCase(), id: opts.id ?? "", classList: opts.cls ?? [], attrs: opts.attrs ?? {}, parentElement: null, children: kids, getAttribute(name) { return this.attrs[name] ?? null; } };
  for (const kid of kids) kid.parentElement = node;
  return node;
}
function rootFor(matches: Record<string, number>) { return { querySelectorAll: (selector: string) => ({ length: matches[selector] ?? 2 }) }; }

test("cssSelectorFor prefers ids, test ids, then classes with nth-of-type", () => {
  const button = el("button", { cls: ["btn", "primary", "md:px-4"] });
  const other = el("button", { cls: ["btn"] });
  const card = el("div", { cls: ["card"] }, [other, button]);
  el("main", { id: "app" }, [card]);
  assert.equal(cssSelectorFor(button, rootFor({ "#app > div.card > button.btn.primary:nth-of-type(2)": 1 })), "#app > div.card > button.btn.primary:nth-of-type(2)");
  const save = el("button", { attrs: { "data-testid": "save" } });
  el("div", {}, [save]);
  assert.equal(cssSelectorFor(save, rootFor({ 'button[data-testid="save"]': 1 })), 'button[data-testid="save"]');
  const titled = el("h1", { id: "title" });
  assert.equal(cssSelectorFor(titled, rootFor({ "#title": 1 })), "#title");
});

test("trimOuterHtml compacts and truncates", () => {
  assert.equal(trimOuterHtml("<div>\n   <b>a</b>\n</div>"), "<div><b>a</b></div>");
  assert.match(trimOuterHtml("x".repeat(2000), 100), /생략/);
});

test("attachment blocks never trigger media routing", () => {
  const block = "버튼 고쳐줘\n\n```orchestra-attachments\n주요 스타일: background-image: none; UI 로고 이미지\n```";
  assert.equal(stripPreviewAttachments(block).includes("로고"), false);
  assert.equal(mediaRouteRequired(block, []), false);
  assert.equal(mediaRouteRequired("로고 이미지 만들어줘", []), true);
});

test("proxy injects the picker, rewrites redirects and tunnels websockets", async () => {
  const upstream = createServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { location: `http://127.0.0.1:${(upstream.address() as any).port}/page` }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
    res.end(`<html><head></head><body>host=${req.headers.host}</body></html>`);
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo:${data}`)));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const port = (upstream.address() as any).port;
  const proxies = new PreviewProxies();
  try {
    const proxy = await proxies.open(new URL(`http://127.0.0.1:${port}/`));
    const page = await fetch(`${proxy.origin}/`, { headers: { accept: "text/html" } });
    const html = await page.text();
    assert.match(html, /__orchestra\/picker\.js/);
    assert.match(html, new RegExp(`host=127.0.0.1:${port}`));
    assert.equal(page.headers.get("x-frame-options"), null);
    assert.equal(page.headers.get("content-security-policy"), null);
    const redirect = await fetch(`${proxy.origin}/go`, { redirect: "manual" });
    assert.equal(redirect.headers.get("location"), `${proxy.origin}/page`);
    const script = await (await fetch(`${proxy.origin}/__orchestra/picker.js`)).text();
    assert.match(script, /orchestra-preview/);
    const h2i = await (await fetch(`${proxy.origin}/__orchestra/h2i.js`)).text();
    assert.match(h2i, /toPng/);
    assert.match(await (await fetch(`${proxy.origin}/__orchestra/eruda.js`)).text(), /eruda/);
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/hmr`);
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (data) => { resolve(String(data)); ws.close(); });
      ws.on("error", reject);
    });
    assert.equal(reply, "echo:hi");
  } finally {
    proxies.close();
    wss.close();
    upstream.close();
  }
});
