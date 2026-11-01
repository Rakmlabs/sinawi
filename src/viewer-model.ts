import { fileNameOf, kindFromName, KIND_LABEL, type MediaKind } from "../server/media-kinds";

export type MediaRef = { path: string; name: string; kind: MediaKind; size?: number };

export const GALLERY_PREVIEW = 4;

export type GalleryCell<T> = { item: T; index: number; more: number };

/** Up to four thumbnails. A fifth image onwards badges the last cell with the hidden count. */
export function galleryCells<T>(items: T[], max = GALLERY_PREVIEW): GalleryCell<T>[] {
  if (items.length <= max) return items.map((item, index) => ({ item, index, more: 0 }));
  return items.slice(0, max).map((item, index) => ({ item, index, more: index === max - 1 ? items.length - max : 0 }));
}

export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

/** Tab cycle inside the file viewer. null means the browser can move to the next control. */
export function trapFocusIndex(count: number, activeIndex: number, shift: boolean): number | "dialog" | null {
  if (count <= 0) return "dialog";
  if (activeIndex < 0 || (shift && activeIndex === 0) || (!shift && activeIndex === count - 1)) {
    return shift ? count - 1 : 0;
  }
  return null;
}

export function clampZoom(zoom: number, min = 1, max = 4): number {
  if (!Number.isFinite(zoom)) return min;
  return Math.min(max, Math.max(min, Math.round(zoom * 100) / 100));
}

/** Swipe left moves forward. Mostly-vertical drags are ignored. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return 0;
  return dx < 0 ? 1 : -1;
}

export function formatBytes(size: number | undefined): string {
  if (size == null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

export function kindLabel(kind: MediaKind): string {
  return KIND_LABEL[kind];
}

export function isLongText(text: string): boolean {
  return text.length > 3_500 || text.split("\n").length > 70;
}

const REMOTE = /^(?:https?:|data:|blob:)/i;

export function mediaUrl(sessionId: string | undefined, path: string, query?: { download?: boolean; text?: boolean; preview?: boolean; meta?: boolean }): string {
  if (REMOTE.test(path)) return path;
  const base = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/file` : "/api/preview/file";
  const params = new URLSearchParams({ path });
  if (query?.download) params.set("download", "1");
  if (query?.text) params.set("text", "1");
  if (query?.preview) params.set("preview", "pdf");
  if (query?.meta) params.set("meta", "1");
  return `${base}?${params.toString()}`;
}

export function fileActionUrl(sessionId: string | undefined): string {
  return sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/file/open` : "/api/preview/file/open";
}

export function imageMedia(src: string, alt = ""): MediaRef {
  const kind = kindFromName(src);
  return { path: src, name: alt.trim() || fileNameOf(src), kind: kind === "unknown" ? "image" : kind };
}

export function localMediaRef(href: string, label?: string): MediaRef | undefined {
  if (!href || REMOTE.test(href) || href.startsWith("//") || href.startsWith("#") || href.startsWith("/api/") || /^(?:mailto:|javascript:)/i.test(href)) return undefined;
  const path = href.replace(/^file:\/\//, "").split(/[?#]/)[0];
  const kind = kindFromName(path);
  if (kind === "unknown") return undefined;
  const name = label?.trim();
  return { path, name: name && name !== href ? name : fileNameOf(path), kind };
}

export function isUnfurlLink(href: string | undefined, label: string): boolean {
  if (!href || !/^https:\/\//i.test(href)) return false;
  const text = label.trim();
  return text === href || text === href.replace(/\/$/, "") || text === href.replace(/^https:\/\//, "").replace(/\/$/, "");
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*<?([^>\s)]+)>?(?:\s+"[^"]*")?\s*\)$/;

export function clusterGallery(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence = false;
  let group: { src: string; alt: string; raw: string }[] = [];
  let pendingBlank: string[] = [];
  const flush = (trailing: string[]) => {
    if (group.length >= 2) {
      out.push("```orchestra-gallery");
      for (const item of group) out.push(JSON.stringify({ src: item.src, alt: item.alt }));
      out.push("```");
      if (trailing.length) out.push("");
    } else {
      for (const item of group) out.push(item.raw);
      out.push(...trailing);
    }
    group = [];
  };
  for (const line of lines) {
    if (fence) { out.push(line); if (/^```/.test(line.trim())) fence = false; continue; }
    if (/^```/.test(line.trim())) { flush(pendingBlank); pendingBlank = []; fence = true; out.push(line); continue; }
    const image = IMAGE_LINE.exec(line.trim());
    if (image) { pendingBlank = []; group.push({ alt: image[1], src: image[2], raw: line }); continue; }
    if (!line.trim() && group.length) { pendingBlank.push(line); continue; }
    flush(pendingBlank);
    pendingBlank = [];
    out.push(line);
  }
  flush(pendingBlank);
  return out.join("\n");
}

export function parseGalleryPayload(code: string): MediaRef[] {
  const items: MediaRef[] = [];
  for (const line of code.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { src?: unknown; alt?: unknown };
      if (typeof parsed.src !== "string" || !parsed.src) continue;
      items.push(imageMedia(parsed.src, typeof parsed.alt === "string" ? parsed.alt : ""));
    } catch { /* skip a broken line */ }
  }
  return items;
}

export function parseAttachmentMessage(text: string): { body: string; images: MediaRef[]; files: MediaRef[] } {
  const images: MediaRef[] = [];
  const files: MediaRef[] = [];
  const body = text.replace(/```orchestra-attachments\n([\s\S]*?)```/g, (_, block: string) => {
    for (const section of String(block).split(/\n(?=## )/)) {
      const heading = (section.split("\n")[0] ?? "").replace(/^##\s*\[[^\]]+\]\s*/, "");
      const file = section.match(/(?:^|\n)파일: (.+)/)?.[1]?.trim();
      const shot = section.match(/(?:^|\n)요소 캡처: (.+)/)?.[1]?.trim();
      const path = file || shot;
      if (!path) continue;
      const kind = kindFromName(path);
      const ref: MediaRef = { path, name: file ? fileNameOf(path) : (heading.replace(/^첨부한 파일\s*/, "").trim() || fileNameOf(path)), kind: kind === "unknown" ? "text" : kind };
      const asImage = heading.startsWith("첨부한 이미지") || kind === "image" || (!file && Boolean(shot));
      if (asImage) images.push({ ...ref, kind: "image", name: fileNameOf(path) });
      else files.push(ref);
    }
    return "";
  }).trim();
  return { body, images, files };
}

export function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => { rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { cell += "\""; i += 1; } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === "\"" && cell === "") { quoted = true; continue; }
    if (char === ",") { pushCell(); continue; }
    if (char === "\n") { pushCell(); pushRow(); if (rows.length >= maxRows) return rows; continue; }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell || row.length) { pushCell(); pushRow(); }
  return rows.slice(0, maxRows);
}

export const UPLOAD_LIMIT = 80 * 1024 * 1024;

export function uploadRejection(file: { name: string; size: number }): string | undefined {
  if (file.size > UPLOAD_LIMIT) return `${file.name}: 80MB보다 큰 파일은 작업 폴더에 두고 열어 주세요.`;
  return undefined;
}

export function uploadFraction(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, loaded / total));
}
