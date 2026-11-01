import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { uploadFraction, uploadRejection } from "../viewer-model";
import type { ComposerAttachment } from "../preview-attachments";
import { t } from "../i18n";

/**
 * Composer attachments: browser element captures, pasted images and dropped files.
 * Images preview immediately, then each file uploads with progress.
 */
export function useAttachments(composerInput: RefObject<HTMLTextAreaElement | null>, onRejected: (message: string) => void) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const uploads = useRef(new Map<string, XMLHttpRequest>());
  const fileInput = useRef<HTMLInputElement>(null);
  const addAttachments = useCallback((items: ComposerAttachment[]) => {
    setAttachments((old) => [...old, ...items].slice(-20));
    requestAnimationFrame(() => composerInput.current?.focus());
  }, [composerInput]);
  const patchAttachment = useCallback((id: string, patch: Partial<ComposerAttachment>) => {
    setAttachments((old) => old.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);
  const attachFiles = (input: File[]) => {
    const files = input.slice(0, 12);
    const rejected = files.map((file) => uploadRejection(file)).find(Boolean);
    const accepted = files.filter((file) => !uploadRejection(file));
    if (rejected) onRejected(rejected);
    if (!accepted.length) return;
    const pending = accepted.map((file) => {
      const image = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
      return {
        id: Math.random().toString(36).slice(2, 10),
        kind: image ? "image" as const : "file" as const,
        label: file.name && file.name !== "image.png" ? file.name : image ? t("common.image") : t("common.file"),
        preview: image ? URL.createObjectURL(file) : undefined,
        size: file.size,
        progress: 0,
      };
    });
    setAttachments((old) => [...old, ...pending].slice(-20));
    for (const [index, file] of accepted.entries()) {
      const id = pending[index].id;
      const xhr = new XMLHttpRequest();
      uploads.current.set(id, xhr);
      xhr.open("POST", "/api/preview/assets/raw");
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name || pending[index].label));
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) patchAttachment(id, { progress: uploadFraction(event.loaded, event.total) }); };
      xhr.onload = () => {
        uploads.current.delete(id);
        let data: { path?: string; error?: string } = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* keep */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.path) patchAttachment(id, { screenshotPath: data.path, progress: undefined, error: undefined });
        else patchAttachment(id, { progress: undefined, error: data.error || t("attach.saveFailed") });
      };
      xhr.onerror = () => { uploads.current.delete(id); patchAttachment(id, { progress: undefined, error: t("attach.saveFailed") }); };
      xhr.onabort = () => { uploads.current.delete(id); setAttachments((old) => old.filter((item) => item.id !== id)); };
      xhr.send(file);
    }
  };
  const removeAttachment = (item: ComposerAttachment) => {
    uploads.current.get(item.id)?.abort();
    if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    setAttachments((old) => old.filter((other) => other.id !== item.id));
  };
  const pasteImage = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const fromItems = files.length ? [] : Array.from(event.clipboardData?.items ?? []).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    const images = (files.length ? files : fromItems).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!images.length) return;
    event.preventDefault();
    attachFiles(images);
  };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // A file dropped outside the composer must not navigate the app window to that file.
    const block = (event: DragEvent) => { if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => { window.removeEventListener("dragover", block); window.removeEventListener("drop", block); };
  }, []);
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } },
    onDragOver: (event: React.DragEvent) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: React.DragEvent) => {
      const files = Array.from(event.dataTransfer.files ?? []);
      setDragging(false);
      if (!files.length) return;
      event.preventDefault();
      attachFiles(files);
    },
  };
  const attachmentsReady = attachments.every((item) => item.progress == null && !item.error);
  return { attachments, setAttachments, attachmentsReady, addAttachments, attachFiles, removeAttachment, pasteImage, fileInput, dragging, dropHandlers };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;
