import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FolderOpen, Minus, Plus, X } from "lucide-react";
import { MarkdownSessionContext, localImageSrc } from "./markdown-images";
import { Markdown } from "./Markdown";
import { pdfRenderError, PdfCanvas } from "./PdfCanvas";
import { writeClipboard } from "./CopyButton";
import { clampZoom, fileActionUrl, formatBytes, kindLabel, mediaUrl, parseCsv, stepIndex, swipeDirection, trapFocusIndex, type MediaRef } from "./viewer-model";
import { t } from "./i18n";
import { WebLink } from "./WebLink";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const LOCAL = /^(?:https?:|data:|blob:)/i;

export function FileViewer({ items, index, onIndex, onClose }: {
  items: MediaRef[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const sessionId = useContext(MarkdownSessionContext);
  const dialog = useRef<HTMLDivElement>(null);
  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [text, setText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [textError, setTextError] = useState("");
  const [office, setOffice] = useState<{ phase: "loading" | "ready" | "fallback"; url?: string; message?: string }>({ phase: "loading" });
  const [metaPath, setMetaPath] = useState("");
  const [metaSize, setMetaSize] = useState<number | undefined>(current?.size);
  const [notice, setNotice] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const local = Boolean(current && !LOCAL.test(current.path));

  useEffect(() => {
    const previous = document.activeElement;
    if (previous instanceof HTMLElement && previous !== dialog.current) restoreFocus.current = previous;
    dialog.current?.focus();
    return () => {
      const node = restoreFocus.current;
      if (node?.isConnected) node.focus();
    };
  }, []);
  useEffect(() => { setZoom(1); setPage(1); setPages(1); setNotice(""); setImageFailed(false); setMetaSize(current?.size); setMetaPath(current?.path ?? ""); }, [current?.path, current?.size]);

  useEffect(() => {
    if (!current || !local) { setMetaPath(current?.path ?? ""); return; }
    let cancel = false;
    void fetch(mediaUrl(sessionId, current.path, { meta: true })).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json() as { path?: string; size?: number };
      if (cancel) return;
      if (typeof data.path === "string") setMetaPath(data.path);
      if (typeof data.size === "number") setMetaSize(data.size);
    }).catch(() => {});
    return () => { cancel = true; };
  }, [current, local, sessionId]);

  useEffect(() => {
    if (!current || !["text", "code", "markdown", "csv"].includes(current.kind) || !local) { setText(""); setTextError(""); return; }
    let cancel = false;
    setText(""); setTextError(""); setTruncated(false);
    void fetch(mediaUrl(sessionId, current.path, { text: true })).then(async (res) => {
      const data = await res.json().catch(() => ({})) as { text?: string; truncated?: boolean; error?: string };
      if (cancel) return;
      if (!res.ok) { setTextError(data.error || t("viewer.readFailed")); return; }
      setText(data.text ?? "");
      setTruncated(Boolean(data.truncated));
    }).catch(() => { if (!cancel) setTextError(t("viewer.readFailed")); });
    return () => { cancel = true; };
  }, [current, local, sessionId]);

  useEffect(() => {
    if (!current || (current.kind !== "office" && current.kind !== "hwp")) { setOffice({ phase: "ready" }); return; }
    let cancel = false;
    let objectUrl = "";
    setOffice({ phase: "loading" });
    void fetch(mediaUrl(sessionId, current.path, { preview: true })).then(async (res) => {
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("json")) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (!cancel) setOffice({ phase: "fallback", message: data.error || t("viewer.convertFailed") });
        return;
      }
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      if (cancel) { URL.revokeObjectURL(objectUrl); return; }
      setOffice({ phase: "ready", url: objectUrl });
    }).catch(() => { if (!cancel) setOffice({ phase: "fallback", message: t("viewer.convertFailed") }); });
    return () => { cancel = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [current, sessionId]);

  const move = useCallback((delta: number) => {
    if (!current) return;
    if (items.length > 1) onIndex(stepIndex(index, delta, items.length));
    else if (current.kind === "pdf" || current.kind === "office" || current.kind === "hwp") setPage((value) => Math.min(pages, Math.max(1, value + delta)));
  }, [current, index, items.length, onIndex, pages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === "Tab") {
        const root = dialog.current;
        if (!root) return;
        const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const activeIndex = nodes.indexOf(document.activeElement as HTMLElement);
        const next = trapFocusIndex(nodes.length, activeIndex, event.shiftKey);
        if (next === "dialog") { event.preventDefault(); root.focus(); return; }
        if (typeof next === "number") { event.preventDefault(); nodes[next]?.focus(); }
        return;
      }
      if (typing) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom((value) => clampZoom(value + 0.25, current?.kind === "image" ? 1 : 0.5, current?.kind === "image" ? 4 : 3)); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); setZoom((value) => clampZoom(value - 0.25, current?.kind === "image" ? 1 : 0.5, current?.kind === "image" ? 4 : 3)); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [move, onClose, current?.kind]);

  if (!current) return null;
  const src = local ? mediaUrl(sessionId, current.path) : current.path;
  const pdfSrc = current.kind === "pdf" ? src : office.url;
  const showPager = current.kind === "pdf" || ((current.kind === "office" || current.kind === "hwp") && office.phase === "ready");

  const act = async (action: "reveal" | "open" | "quicklook" | "download") => {
    setNotice("");
    try {
      const res = await fetch(fileActionUrl(sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: current.path, action }) });
      const data = await res.json().catch(() => ({})) as { error?: string; path?: string };
      if (!res.ok) setNotice(data.error || t("viewer.openFailed"));
      else if (action === "download" && data.path) setNotice(t("viewer.downloaded", { path: data.path }));
    } catch { setNotice(t("viewer.openFailed")); }
  };
  const copyPath = async () => {
    const value = metaPath || current.path;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    setNotice(await writeClipboard(value, clipboard) ? t("viewer.pathCopied") : t("viewer.pathCopyFailed"));
  };

  const rows = current.kind === "csv" ? parseCsv(text) : [];
  return <div className="viewer-backdrop" onMouseDown={onClose}>
    <div ref={dialog} className="viewer-dialog" role="dialog" aria-modal="true" aria-label={current.name} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header className="viewer-toolbar">
        <div className="viewer-title">
          <strong>{current.name}</strong>
          <span>{kindLabel(current.kind)}{formatBytes(metaSize) ? ` ${formatBytes(metaSize)}` : ""}{items.length > 1 ? ` ${index + 1}/${items.length}` : ""}</span>
        </div>
        <div className="viewer-actions">
          {current.kind === "image" && <>
            <button type="button" aria-label={t("viewer.zoomOut")} onClick={() => setZoom((value) => clampZoom(value - 0.5))}><Minus size={16} /></button>
            <button type="button" aria-label={t("viewer.zoomIn")} onClick={() => setZoom((value) => clampZoom(value + 0.5))}><Plus size={16} /></button>
          </>}
          {showPager && <>
            <button type="button" aria-label={t("viewer.prevPage")} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button>
            <span className="viewer-page">{page}/{pages}</span>
            <button type="button" aria-label={t("viewer.nextPage")} disabled={page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}><ChevronRight size={16} /></button>
            <button type="button" aria-label={t("viewer.zoomOut")} onClick={() => setZoom((value) => clampZoom(value - 0.25, 0.5, 3))}><Minus size={16} /></button>
            <button type="button" aria-label={t("viewer.zoomIn")} onClick={() => setZoom((value) => clampZoom(value + 0.25, 0.5, 3))}><Plus size={16} /></button>
          </>}
          {items.length > 1 && <>
            <button type="button" aria-label={t("viewer.prevFile")} onClick={() => move(-1)}><ChevronLeft size={16} /></button>
            <button type="button" aria-label={t("viewer.nextFile")} onClick={() => move(1)}><ChevronRight size={16} /></button>
          </>}
          {local && <>
            <button type="button" onClick={() => void act("reveal")}><FolderOpen size={15} />{t("viewer.reveal")}</button>
            <button type="button" onClick={() => void act("open")}><ExternalLink size={15} />{t("viewer.openDefault")}</button>
            <button type="button" onClick={() => void act("quicklook")}>Quick Look</button>
            <button type="button" onClick={() => void copyPath()}><Copy size={15} />{t("viewer.copyPath")}</button>
          </>}
          {local ? <button type="button" className="viewer-download" onClick={() => void act("download")}><Download size={15} />{t("viewer.download")}</button>
            : <WebLink className="viewer-download" href={src}><Download size={15} />{t("viewer.download")}</WebLink>}
          <button type="button" className="viewer-close" aria-label={t("viewer.close")} onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      {notice && <p className="viewer-notice" role="status">{notice}</p>}
      <div className="viewer-stage" onPointerDown={(event) => { if (current.kind === "image" && zoom <= 1) drag.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={(event) => {
          if (!drag.current || items.length < 2) { drag.current = null; return; }
          const direction = swipeDirection(event.clientX - drag.current.x, event.clientY - drag.current.y);
          drag.current = null;
          if (direction) onIndex(stepIndex(index, direction, items.length));
        }}>
        {current.kind === "image" && (imageFailed
          ? <p className="viewer-status" role="alert">{t("viewer.imageFailed")}</p>
          : <img className="viewer-image" src={local ? (localImageSrc(current.path, sessionId) ?? src) : src} alt={current.name} style={{ width: `${zoom * 100}%` }} onDoubleClick={() => setZoom((value) => value > 1 ? 1 : 2)} onError={() => setImageFailed(true)} />)}
        {current.kind === "video" && <div className="viewer-video"><video key={src} src={src} controls playsInline preload="metadata" /></div>}
        {current.kind === "audio" && <div className="viewer-audio"><audio key={src} src={src} controls preload="metadata" /></div>}
        {current.kind === "pdf" && <div className="viewer-pdf"><PdfCanvas url={src} page={page} scale={zoom} onPages={setPages} onError={() => setNotice(pdfRenderError())} /></div>}
        {(current.kind === "office" || current.kind === "hwp") && office.phase === "loading" && <p className="viewer-status" role="status">{t("viewer.converting")}</p>}
        {(current.kind === "office" || current.kind === "hwp") && office.phase === "fallback" && <div className="viewer-fallback">
          <p>{office.message}</p>
          <button type="button" onClick={() => void act("quicklook")}>{t("viewer.quickLook")}</button>
        </div>}
        {(current.kind === "office" || current.kind === "hwp") && office.phase === "ready" && pdfSrc && <div className="viewer-pdf"><PdfCanvas url={pdfSrc} page={page} scale={zoom} onPages={setPages} onError={() => setOffice({ phase: "fallback", message: t("viewer.pdfFallback") })} /></div>}
        {textError && <p className="viewer-status" role="alert">{textError}</p>}
        {current.kind === "markdown" && text && <div className="viewer-markdown"><Markdown text={text} /></div>}
        {current.kind === "csv" && text && <div className="viewer-table-wrap"><table>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</table></div>}
        {(current.kind === "text" || current.kind === "code") && text && <pre className="viewer-text"><code>{text}</code></pre>}
        {truncated && <p className="viewer-status">{t("viewer.truncated")}</p>}
      </div>
      {items.length > 1 && <div className="viewer-strip" aria-label={t("viewer.thumbnails")}>
        {items.map((item, itemIndex) => <button type="button" key={`${item.path}-${itemIndex}`} aria-current={itemIndex === index} aria-label={`${itemIndex + 1} ${item.name}`} onClick={() => onIndex(itemIndex)}>
          {item.kind === "image" ? <img src={localImageSrc(item.path, sessionId) ?? item.path} alt="" /> : <span>{item.name}</span>}
        </button>)}
      </div>}
    </div>
  </div>;
}
