import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { safeUploadName } from "./preview.js";
import { convertToPdf, fileActionCommand, officeConverter, registerSessionFileRoutes, type CommandRunner } from "./session-files.js";
import { extractPreview, isBlockedAddress, loadLinkPreview, previewTarget, registerLinkPreviewRoute } from "./link-preview.js";

test("office open commands never go through a shell", () => {
  assert.deepEqual(fileActionCommand("reveal", "/tmp/a.pdf", "darwin"), { command: "/usr/bin/open", args: ["-R", "/tmp/a.pdf"] });
  assert.deepEqual(fileActionCommand("quicklook", "/tmp/a.hwp", "darwin").command, "/usr/bin/qlmanage");
  assert.equal(officeConverter({ lookup: () => undefined, platform: "linux", candidates: [] }), undefined);
  assert.equal(officeConverter({ lookup: (name) => name === "soffice" ? "/opt/soffice" : undefined, platform: "linux" }), "/opt/soffice");
});

test("upload names cannot escape the attachment folder", () => {
  assert.equal(safeUploadName("..%2F..%2Fsecret.pdf"), "_.._secret.pdf");
  assert.equal(safeUploadName(".hidden.pdf").startsWith("."), false);
  assert.equal(safeUploadName(undefined), "file");
});

function listen(app: ReturnType<typeof express>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("포트를 열지 못했습니다.")); return; }
      resolve({ server, port: address.port });
    });
    server.once("error", reject);
  });
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("pdf conversion is cached from an injected converter", async () => {
  const root = await mkdtemp(join(tmpdir(), "ao-convert-"));
  try {
    const source = join(root, "note.docx");
    await writeFile(source, "docx");
    const run: CommandRunner = async (_command, args) => {
      const outDir = args[args.indexOf("--outdir") + 1];
      const file = args.at(-1) ?? "";
      await writeFile(join(outDir, `${basename(file, extname(file))}.pdf`), "%PDF");
    };
    const first = await convertToPdf(source, join(root, "cache"), "/opt/soffice", run);
    const second = await convertToPdf(source, join(root, "cache"), "/opt/soffice", async () => { throw new Error("should use cache"); });
    assert.equal(first, second);
    assert.match(first, /preview\.pdf$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session and preview file routes stay inside their roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "ao-view-"));
  const cwd = join(root, "site");
  const preview = join(root, "uploads");
  const cache = join(root, "cache");
  await mkdir(join(cwd, "docs"), { recursive: true });
  await mkdir(preview, { recursive: true });
  await writeFile(join(cwd, "docs/a.png"), "png");
  await writeFile(join(cwd, "docs/page.html"), "<script>alert(1)</script>");
  await writeFile(join(cwd, "docs/note.txt"), "hello");
  await writeFile(join(root, "secret.png"), "nope");
  await writeFile(join(preview, "clip.pdf"), "%PDF");
  await symlink(join(root, "secret.png"), join(cwd, "link.png"));
  const launched: string[][] = [];
  const app = express();
  app.use(express.json());
  registerSessionFileRoutes(app, {
    lookup: (id) => id === "s1" ? { cwd } : undefined,
    extraRoots: () => [],
    previewRoot: () => preview,
    cacheDir: () => cache,
    converter: () => undefined,
    launch: (command, args) => { launched.push([command, ...args]); },
  });
  const { server, port } = await listen(app);
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  try {
    const image = await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/a.png")}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type") ?? "", /image\/png/);
    assert.equal((await get(`/api/sessions/s1/file?path=${encodeURIComponent("../secret.png")}`)).status, 403);
    assert.equal((await get(`/api/sessions/s1/file?path=${encodeURIComponent("link.png")}`)).status, 403);
    assert.equal((await get("/api/sessions/missing/file?path=docs/a.png")).status, 404);
    const html = await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/page.html")}`);
    assert.match(html.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    const text = await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/note.txt")}&text=1`);
    assert.equal((await text.json()).text, "hello");
    const download = await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/a.png")}&download=1`);
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment/);
    const meta = await (await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/note.txt")}&meta=1`)).json();
    assert.equal(meta.kind, "text");
    assert.equal(meta.size, 5);
    const opened = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/file/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "docs/a.png", action: "reveal" }) });
    assert.equal(opened.status, 200);
    assert.deepEqual(launched[0]?.slice(1), ["-R", await realpath(join(cwd, "docs/a.png"))]);
    const outside = await fetch(`http://127.0.0.1:${port}/api/preview/file?path=${encodeURIComponent(join(cwd, "docs/a.png"))}`);
    assert.equal(outside.status, 403);
    const clip = await get(`/api/preview/file?path=${encodeURIComponent(join(preview, "clip.pdf"))}`);
    assert.equal(clip.status, 200);
    assert.match(clip.headers.get("content-type") ?? "", /pdf/);
    const office = await get(`/api/sessions/s1/file?path=${encodeURIComponent("docs/note.txt")}&preview=pdf`);
    assert.equal(office.status, 415);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("link preview rejects private targets before any request", async () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("10.1.2.3"), true);
  assert.equal(isBlockedAddress("192.168.0.5"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(previewTarget("http://example.com"), undefined);
  assert.equal(previewTarget("https://user:pass@example.com"), undefined);
  assert.equal(previewTarget("https://localhost/a"), undefined);
  assert.equal(previewTarget("file:///etc/passwd"), undefined);
  const html = `<html><head><title>무시</title><meta property="og:title" content="문서"><meta property="og:description" content="설명"><meta property="og:image" content="http://127.0.0.1/x.png"><meta property="og:site_name" content="Example"></head></html>`;
  const preview = extractPreview(html, "https://example.com/a");
  assert.equal(preview?.title, "문서");
  assert.equal(preview?.image, undefined);
  let requested = false;
  await assert.rejects(loadLinkPreview("https://example.com", {
    lookup: async () => ["127.0.0.1"],
    request: async () => { requested = true; return { status: 200, headers: {}, body: "" }; },
  }));
  assert.equal(requested, false);
  const loaded = await loadLinkPreview("https://example.com/a", {
    lookup: async () => ["8.8.8.8"],
    request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: html }),
  });
  assert.equal(loaded.title, "문서");
  assert.equal(loaded.site, "Example");
});

test("link preview route returns the guard error", async () => {
  const app = express();
  registerLinkPreviewRoute(app, { lookup: async () => ["10.0.0.1"], request: async () => { throw new Error("should not fetch"); } });
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/link-preview?url=${encodeURIComponent("https://example.com")}`);
    assert.equal(res.status, 400);
  } finally { await close(server); }
});
