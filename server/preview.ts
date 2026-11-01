import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Express, Request, Response } from "express";
import { pickerScript } from "./preview-picker.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackTarget(raw: string): URL | undefined {
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { return undefined; }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK.has(host) && !host.endsWith(".localhost")) return undefined;
  return url;
}

/** Normalizes what a user typed in the URL bar: "3000" → localhost:3000, "foo.com" → https://foo.com. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (/^\d{2,5}$/.test(value)) return `http://localhost:${value}/`;
  if (/^:\d{2,5}(\/.*)?$/.test(value)) return `http://localhost${value}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^[^\s/]+\.[^\s/]+/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

const moduleCache = new Map<string, string>();
/** Reads a bundled browser library (served to proxied pages; never from a CDN). */
export function moduleSource(spec: string): string {
  const cached = moduleCache.get(spec);
  if (cached !== undefined) return cached;
  const bases = [typeof __filename === "string" ? __filename : join(process.cwd(), "index.js"), join(process.cwd(), "index.js")];
  for (const base of bases) {
    try { const text = readFileSync(createRequire(base).resolve(spec), "utf8"); moduleCache.set(spec, text); return text; } catch { /* try next */ }
  }
  moduleCache.set(spec, "");
  return "";
}

let h2iCache: string | undefined;
function h2iSource(): string {
  if (h2iCache !== undefined) return h2iCache;
  const bases = [typeof __filename === "string" ? __filename : join(process.cwd(), "index.js"), join(process.cwd(), "index.js")];
  for (const base of bases) {
    try { h2iCache = readFileSync(createRequire(base).resolve("html-to-image/dist/html-to-image.js"), "utf8"); return h2iCache; } catch { /* try next */ }
  }
  h2iCache = "";
  return h2iCache;
}

export function injectPicker(html: string): string {
  const tag = `<script src="/__orchestra/picker.js"></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag?.index !== undefined) return html.slice(0, htmlTag.index + htmlTag[0].length) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}

type Proxy = { target: URL; server: Server; port: number; origin: string };

export class PreviewProxies {
  private proxies = new Map<string, Promise<Proxy>>();

  ports(): number[] { return [...this.proxies.keys()].map((key) => Number(key.split("|")[1] ?? 0)).filter(Boolean); }
  private listening = new Set<number>();
  ownPorts(): Set<number> { return this.listening; }

  open(target: URL): Promise<Proxy> {
    const key = target.origin;
    let proxy = this.proxies.get(key);
    if (!proxy) {
      proxy = this.start(new URL(target.origin));
      this.proxies.set(key, proxy);
      proxy.catch(() => this.proxies.delete(key));
    }
    return proxy;
  }

  close() { for (const proxy of this.proxies.values()) void proxy.then((p) => p.server.close()).catch(() => undefined); this.proxies.clear(); }

  private start(target: URL): Promise<Proxy> {
    const targetHost = target.host;
    const targetPort = Number(target.port || 80);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    let origin = "";
    const rewriteHeaders = (headers: IncomingMessage["headers"]) => {
      const next: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) next[name] = value;
      next.host = targetHost;
      if (typeof next.origin === "string" && next.origin === origin) next.origin = target.origin;
      if (typeof next.referer === "string" && next.referer.startsWith(origin)) next.referer = target.origin + next.referer.slice(origin.length);
      return next;
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? "/";
      if (path === "/__orchestra/picker.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(pickerScript()); return;
      }
      if (path === "/__orchestra/eruda.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" });
        res.end(moduleSource("eruda/eruda.js")); return;
      }
      if (path === "/__orchestra/h2i.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" });
        res.end(h2iSource()); return;
      }
      const headers = rewriteHeaders(req.headers);
      const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
      if (wantsHtml) headers["accept-encoding"] = "identity";
      const upstream = httpRequest({ hostname, port: targetPort, method: req.method, path, headers }, (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(up.headers)) if (value !== undefined) out[name] = value;
        delete out["x-frame-options"]; delete out["content-security-policy"]; delete out["content-security-policy-report-only"];
        if (typeof out.location === "string" && out.location.startsWith(target.origin)) out.location = origin + out.location.slice(target.origin.length);
        if (out["set-cookie"]) out["set-cookie"] = ([] as string[]).concat(out["set-cookie"]).map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, "").replace(/;\s*samesite=none/gi, "; SameSite=Lax"));
        const type = String(up.headers["content-type"] ?? "");
        const encoding = String(up.headers["content-encoding"] ?? "identity");
        if (type.includes("text/html") && (encoding === "identity" || encoding === "") && req.method !== "HEAD") {
          const chunks: Buffer[] = [];
          up.on("data", (chunk: Buffer) => chunks.push(chunk));
          up.on("end", () => {
            const html = injectPicker(Buffer.concat(chunks).toString("utf8"));
            delete out["content-length"]; delete out["transfer-encoding"]; delete out.etag;
            out["cache-control"] = "no-store";
            res.writeHead(up.statusCode ?? 200, out);
            res.end(html);
          });
          up.on("error", () => res.destroy());
          return;
        }
        res.writeHead(up.statusCode ?? 200, out);
        up.pipe(res);
      });
      upstream.on("error", (error) => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:18px -apple-system,'Apple SD Gothic Neo',sans-serif;padding:40px;color:#222"><h2>${target.origin} 에 연결할 수 없습니다</h2><p>개발 서버가 켜져 있는지 확인하세요.</p><p style="color:#777">${String(error.message).replace(/[<&]/g, "")}</p><script>setTimeout(()=>location.reload(),4000)</script>`);
      });
      req.pipe(upstream);
    });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const upstream = connect({ host: hostname, port: targetPort }, () => {
        const headers = rewriteHeaders(req.headers);
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [name, value] of Object.entries(headers)) for (const v of ([] as string[]).concat(value)) raw += `${name}: ${v}\r\n`;
        upstream.write(raw + "\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      const end = () => { upstream.destroy(); socket.destroy(); };
      upstream.on("error", end); socket.on("error", end);
      upstream.on("close", () => socket.destroy()); socket.on("close", () => upstream.destroy());
    });
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        origin = `http://127.0.0.1:${port}`;
        this.listening.add(port);
        server.on("close", () => this.listening.delete(port));
        resolvePromise({ target, server, port, origin });
      });
    });
  }
}

export type ListeningPort = { port: number; command: string; url: string };

export function parseLsof(output: string, exclude: Set<number>): ListeningPort[] {
  const found = new Map<number, ListeningPort>();
  let command = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("c")) command = line.slice(1);
    if (!line.startsWith("n")) continue;
    const match = line.match(/^n(?:\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0|localhost):(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (exclude.has(port) || port < 1024 || found.has(port)) continue;
    if (!/^(node|bun|deno|python\d*(\.\d+)?|Python|ruby|php|java|go|cargo|uvicorn|gunicorn|rails|hugo|vite|next-server|npm|pnpm|yarn|esbuild|astro|serve)$/i.test(command)) continue;
    found.set(port, { port, command, url: `http://localhost:${port}/` });
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

function listListeningPorts(exclude: Set<number>): Promise<ListeningPort[]> {
  return new Promise((resolvePromise) => {
    execFile("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"], { timeout: 4000, maxBuffer: 2_000_000 }, (_error, stdout) => {
      resolvePromise(parseLsof(String(stdout ?? ""), exclude));
    });
  });
}

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

export const UPLOAD_LIMIT = 80 * 1024 * 1024;

/** Basename only. Encoded slashes and dotfiles cannot escape the upload folder. */
export function safeUploadName(header: string | undefined): string {
  let name = header ?? "file";
  try { name = decodeURIComponent(name); } catch { /* keep */ }
  name = name.replace(/[\/\\\0]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return name || "file";
}

export function previewAssetsDir(dataDir?: string) {
  return resolve(dataDir ?? join(homedir(), ".sinawi"), "preview-attachments");
}

export function registerPreviewRoutes(app: Express, options: { dataDir?: string; appPort?: number }) {
  const proxies = new PreviewProxies();
  app.post("/api/preview/open", async (req: Request, res: Response) => {
    try {
      const raw = typeof req.body?.url === "string" ? req.body.url.slice(0, 4096) : "";
      const address = normalizeAddress(raw);
      const target = isLoopbackTarget(address);
      if (!target) { res.json({ url: address, frameUrl: address, proxied: false }); return; }
      if (Number(target.port || 80) === (options.appPort ?? 3001) || proxies.ownPorts().has(Number(target.port))) throw new Error("Sinawi 자체 주소는 열 수 없습니다.");
      const proxy = await proxies.open(target);
      res.json({ url: target.href, frameUrl: proxy.origin + target.pathname + target.search + target.hash, proxied: true, proxyOrigin: proxy.origin, targetOrigin: target.origin });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/preview/ports", async (_req: Request, res: Response) => {
    const exclude = new Set([options.appPort ?? 3001, 5188, ...proxies.ownPorts()]);
    res.json({ ports: await listListeningPorts(exclude) });
  });
  app.post("/api/preview/assets", async (req: Request, res: Response) => {
    try {
      const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 40) : [];
      const dir = join(previewAssetsDir(options.dataDir), new Date().toISOString().slice(0, 10));
      await mkdir(dir, { recursive: true });
      const paths: (string | null)[] = [];
      for (const image of images) {
        const match = typeof image === "string" ? image.match(DATA_URL) : null;
        if (!match) { paths.push(null); continue; }
        const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
        await writeFile(file, Buffer.from(match[2], "base64"));
        paths.push(file);
      }
      // Dropped files: { name, data: "data:<any>;base64,..." }, saved under a sanitized original name.
      const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 20) : [];
      const filePaths: (string | null)[] = [];
      for (const item of files) {
        const match = typeof item?.data === "string" ? item.data.match(/^data:[^;,]*(?:;[^;,]*)*;base64,([A-Za-z0-9+/=]*)$/) : null;
        if (!match) { filePaths.push(null); continue; }
        const name = String(item.name ?? "file").replace(/[\/\0]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
        const folder = join(dir, randomUUID().slice(0, 8));
        await mkdir(folder, { recursive: true });
        const file = join(folder, name);
        await writeFile(file, Buffer.from(match[1], "base64"));
        filePaths.push(file);
      }
      res.json({ paths, files: filePaths });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/preview/assets/raw", (req: Request, res: Response) => {
    const name = safeUploadName(typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (status: number, error: string) => {
      if (settled) return;
      settled = true;
      res.status(status).json({ error });
      req.destroy();
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > UPLOAD_LIMIT) { fail(413, "80MB보다 큰 파일은 작업 폴더에 두고 열어 주세요."); return; }
      chunks.push(chunk);
    });
    req.on("error", () => fail(400, "첨부를 저장하지 못했습니다."));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const folder = join(previewAssetsDir(options.dataDir), new Date().toISOString().slice(0, 10), randomUUID().slice(0, 8));
      const file = join(folder, name);
      void mkdir(folder, { recursive: true }).then(() => writeFile(file, Buffer.concat(chunks))).then(() => {
        res.json({ path: file, size, name });
      }).catch(() => { if (!res.headersSent) res.status(400).json({ error: "첨부를 저장하지 못했습니다." }); });
    });
  });
  return proxies;
}
