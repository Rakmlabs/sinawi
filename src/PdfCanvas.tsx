import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

type Pdfjs = typeof import("pdfjs-dist");

let workerReady: Promise<Pdfjs> | undefined;

function loadPdfjs(): Promise<Pdfjs> {
  workerReady ??= import("pdfjs-dist").then(async (pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    }
    return pdfjs;
  });
  return workerReady;
}

export const pdfRenderError = () => t("pdf.renderError");

export function PdfCanvas({ url, page, scale, onPages, onError }: {
  url: string;
  page: number;
  scale: number;
  onPages: (count: number) => void;
  onError: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pagesRef = useRef(onPages);
  const errorRef = useRef(onError);
  pagesRef.current = onPages;
  errorRef.current = onError;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  useEffect(() => {
    if (failed) return;
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    let destroy: (() => Promise<void>) | undefined;
    void loadPdfjs().then(async (pdfjs) => {
      const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
      destroy = () => doc.destroy();
      if (cancelled) { await doc.destroy(); return; }
      pagesRef.current(doc.numPages);
      const current = Math.min(Math.max(1, page), doc.numPages);
      const pdfPage = await doc.getPage(current);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const rendered = pdfPage.render({ canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
      task = rendered;
      await rendered.promise;
    }).catch(() => { if (!cancelled) { setFailed(true); errorRef.current(); } });
    return () => { cancelled = true; task?.cancel(); void destroy?.(); };
  }, [url, page, scale, failed]);
  if (failed) return <div className="viewer-pdf-fallback">
    <p role="alert">{pdfRenderError()}</p>
    <a href={url} target="_blank" rel="noopener noreferrer">{t("pdf.openExternal")}</a>
    <iframe className="viewer-pdf-frame" title="PDF" src={url} />
  </div>;
  return <canvas ref={canvasRef} className="viewer-pdf-canvas" />;
}
