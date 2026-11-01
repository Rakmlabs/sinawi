import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from "lucide-react";
import { MarkdownSessionContext, localImageSrc } from "./markdown-images";
import { formatBytes, galleryCells, isLongText, kindLabel, mediaUrl, parseAttachmentMessage, type MediaRef } from "./viewer-model";
import type { MediaKind } from "../server/media-kinds";

export type ViewerApi = { open: (items: MediaRef[], index: number) => void };

export const ViewerContext = createContext<ViewerApi>({ open: () => {} });

function KindIcon({ kind }: { kind: MediaKind }) {
  const props = { size: 18, "aria-hidden": true as const };
  if (kind === "image") return <FileImage {...props} />;
  if (kind === "video") return <FileVideo {...props} />;
  if (kind === "audio") return <FileAudio {...props} />;
  if (kind === "csv") return <FileSpreadsheet {...props} />;
  if (kind === "office" || kind === "hwp" || kind === "pdf") return <Presentation {...props} />;
  return <FileText {...props} />;
}

export function FileChip({ item }: { item: MediaRef }) {
  const sessionId = useContext(MarkdownSessionContext);
  const open = useContext(ViewerContext).open;
  const [size, setSize] = useState(item.size);
  useEffect(() => {
    if (item.size != null || /^(?:https?:|data:|blob:)/i.test(item.path)) return;
    let cancel = false;
    void fetch(mediaUrl(sessionId, item.path, { meta: true })).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json() as { size?: number };
      if (!cancel && typeof data.size === "number") setSize(data.size);
    }).catch(() => {});
    return () => { cancel = true; };
  }, [item.path, item.size, sessionId]);
  const bytes = formatBytes(size);
  return <button type="button" className="file-chip" onClick={() => open([item], 0)}>
    <KindIcon kind={item.kind} />
    <span className="file-chip-copy">
      <span className="file-chip-name">{item.name}</span>
      <span className="file-chip-meta">{kindLabel(item.kind)}{bytes ? <span>{bytes}</span> : null}</span>
    </span>
  </button>;
}

function frameSrc(src: string, sessionId: string | undefined) {
  return localImageSrc(src, sessionId) ?? src;
}

function GalleryImage({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="image-missing" role="img" aria-label={`${alt || "이미지"}를 표시하지 못했습니다`}>이미지를 표시하지 못했습니다</span>;
  return <img src={src} alt={alt} width={width} height={height} onError={() => setFailed(true)} />;
}

export function ImageGrid({ items }: { items: MediaRef[] }) {
  const sessionId = useContext(MarkdownSessionContext);
  const open = useContext(ViewerContext).open;
  if (items.length === 1) {
    const item = items[0];
    return <button type="button" className="markdown-image" onClick={() => open(items, 0)}>
      <GalleryImage src={frameSrc(item.path, sessionId)} alt={item.name} width={560} height={320} />
    </button>;
  }
  const cells = galleryCells(items);
  return <div className="image-grid" data-count={cells.length}>
    {cells.map((cell) => <button type="button" className="image-cell" key={`${cell.item.path}-${cell.index}`} onClick={() => open(items, cell.index)}>
      <GalleryImage src={frameSrc(cell.item.path, sessionId)} alt={cell.item.name} width={320} height={320} />
      {cell.more > 0 && <span className="image-more">+{cell.more}</span>}
    </button>)}
  </div>;
}

export function MessageFold({ text, streaming, children }: { text: string; streaming?: boolean; children?: ReactNode }) {
  const long = !streaming && isLongText(text);
  const [open, setOpen] = useState(false);
  return <div className="message-fold">
    <div className={long && !open ? "message-fold-clip" : undefined}>{children}</div>
    {long && <button type="button" className="message-fold-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "접기" : "더 보기"}</button>}
  </div>;
}

export function LinkCard({ href }: { href: string }) {
  const [preview, setPreview] = useState<{ title: string; description?: string; image?: string; site: string } | null>(null);
  useEffect(() => {
    let cancel = false;
    void fetch(`/api/link-preview?url=${encodeURIComponent(href)}`).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json() as { title?: string; description?: string; image?: string; site?: string };
      if (!cancel && data.title && data.site) setPreview({ title: data.title, description: data.description, image: data.image, site: data.site });
    }).catch(() => {});
    return () => { cancel = true; };
  }, [href]);
  if (!preview) return null;
  return <a className="link-card" href={href} target="_blank" rel="noreferrer">
    {preview.image && <img src={preview.image} alt="" width={88} height={88} />}
    <span className="link-card-copy"><b>{preview.title}</b><small>{preview.site}</small>{preview.description && <span>{preview.description}</span>}</span>
  </a>;
}

export function UserMessageBody({ text }: { text: string }) {
  const { body, images, files } = parseAttachmentMessage(text);
  return <>
    {body && <span className="user-message-body">{body}</span>}
    {images.length > 0 && <ImageGrid items={images} />}
    {files.length > 0 && <div className="file-chip-row">{files.map((item) => <FileChip key={`${item.path}-${item.name}`} item={item} />)}</div>}
  </>;
}
