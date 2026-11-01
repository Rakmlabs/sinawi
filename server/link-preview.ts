import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type { Express, Request, Response } from "express";

export type LinkPreview = { url: string; title: string; description?: string; image?: string; site: string };

const BLOCKED_HOST = /^(?:localhost|.*\.localhost|.*\.local|metadata\.google\.internal|metadata\.google\.com)$/i;

export function isBlockedAddress(ip: string): boolean {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
    return false;
  }
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a === 255 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (!host || BLOCKED_HOST.test(host)) return true;
  if (isIP(host) && isBlockedAddress(host)) return true;
  return false;
}

/** https only, no credentials, port 443. Blocks localhost names and private IP literals. */
export function previewTarget(raw: string): URL | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (url.port && url.port !== "443") return undefined;
  if (isBlockedHostname(url.hostname)) return undefined;
  return url;
}

export function safePreviewImage(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw, base); } catch { return undefined; }
  if (!previewTarget(url.href)) return undefined;
  return url.href;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num: string) => { const code = Number(num); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""; })
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, key: string): string | undefined {
  const attr = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${attr}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${attr}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(html);
    if (found?.[1]) return decodeEntities(found[1]);
  }
  return undefined;
}

export function extractPreview(html: string, pageUrl: string): LinkPreview | undefined {
  const sliced = html.slice(0, 500_000);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(sliced);
  const title = (metaContent(sliced, "og:title") || (titleTag ? decodeEntities(titleTag[1]) : "")).slice(0, 140);
  if (!title) return undefined;
  const description = (metaContent(sliced, "og:description") || metaContent(sliced, "description") || "").slice(0, 220);
  const site = (metaContent(sliced, "og:site_name") || new URL(pageUrl).hostname).slice(0, 80);
  const image = safePreviewImage(metaContent(sliced, "og:image"), pageUrl);
  return { url: pageUrl, title, description: description || undefined, image, site };
}

export type PreviewDocument = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

function header(headers: PreviewDocument["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function defaultRequest(url: URL, address: string): Promise<PreviewDocument> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: address,
      servername: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: `${url.pathname || "/"}${url.search}`,
      method: "GET",
      timeout: 4000,
      headers: {
        host: url.host,
        "user-agent": "SinawiLinkPreview",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) { req.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => { req.destroy(); reject(Object.assign(new Error("시간 초과"), { status: 504 })); });
    req.on("error", reject);
    req.end();
  });
}

export async function loadLinkPreview(raw: string, deps: {
  lookup?: (hostname: string) => Promise<string[]>;
  request?: (url: URL, address: string) => Promise<PreviewDocument>;
} = {}): Promise<LinkPreview> {
  const lookup = deps.lookup ?? defaultLookup;
  const request = deps.request ?? defaultRequest;
  let current = previewTarget(raw);
  if (!current) throw Object.assign(new Error("미리볼 수 없는 주소입니다."), { status: 400 });
  for (let hop = 0; hop < 3; hop += 1) {
    const addresses = await lookup(current.hostname).catch(() => [] as string[]);
    if (!addresses.length || addresses.some((address) => isBlockedAddress(address))) throw Object.assign(new Error("미리볼 수 없는 주소입니다."), { status: 400 });
    const response = await request(current, addresses[0]);
    const location = header(response.headers, "location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const next = previewTarget(new URL(location, current).href);
      if (!next) throw Object.assign(new Error("미리볼 수 없는 주소입니다."), { status: 400 });
      current = next;
      continue;
    }
    if (response.status !== 200) throw Object.assign(new Error("링크를 열지 못했습니다."), { status: 422 });
    const type = header(response.headers, "content-type");
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw Object.assign(new Error("미리보기가 없는 페이지입니다."), { status: 422 });
    const preview = extractPreview(response.body, current.href);
    if (!preview) throw Object.assign(new Error("제목을 찾지 못했습니다."), { status: 422 });
    return preview;
  }
  throw Object.assign(new Error("리다이렉트가 너무 많습니다."), { status: 422 });
}

export function registerLinkPreviewRoute(app: Express, deps: Parameters<typeof loadLinkPreview>[1] = {}) {
  app.get("/api/link-preview", async (req: Request, res: Response) => {
    try {
      const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
      if (typeof raw !== "string" || raw.length > 4_096) throw Object.assign(new Error("주소가 올바르지 않습니다."), { status: 400 });
      res.setHeader("cache-control", "private, max-age=300");
      res.json(await loadLinkPreview(raw, deps));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
