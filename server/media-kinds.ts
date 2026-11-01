/** Viewable file kinds. Shared by the file server and the chat UI. No Node APIs. */

export type MediaKind = "image" | "pdf" | "video" | "audio" | "text" | "code" | "markdown" | "csv" | "office" | "hwp" | "unknown";

export const KIND_LABEL: Record<MediaKind, string> = {
  image: "이미지",
  pdf: "PDF",
  video: "동영상",
  audio: "오디오",
  text: "텍스트",
  code: "코드",
  markdown: "마크다운",
  csv: "CSV",
  office: "문서",
  hwp: "한글",
  unknown: "파일",
};

const EXT_KIND: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".avif": "image", ".svg": "image",
  ".pdf": "pdf",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio", ".flac": "audio", ".aac": "audio",
  ".txt": "text", ".log": "text", ".json": "text", ".jsonl": "text", ".yml": "text", ".yaml": "text", ".toml": "text", ".ini": "text", ".xml": "text",
  ".md": "markdown", ".markdown": "markdown",
  ".csv": "csv", ".tsv": "csv",
  ".ts": "code", ".tsx": "code", ".js": "code", ".jsx": "code", ".mjs": "code", ".cjs": "code",
  ".py": "code", ".rs": "code", ".go": "code", ".java": "code", ".css": "code", ".html": "code", ".htm": "code",
  ".sh": "code", ".sql": "code", ".rb": "code", ".php": "code", ".swift": "code", ".kt": "code",
  ".c": "code", ".h": "code", ".cpp": "code", ".hpp": "code", ".cs": "code",
  ".docx": "office", ".xlsx": "office", ".pptx": "office", ".doc": "office", ".xls": "office", ".ppt": "office",
  ".odt": "office", ".ods": "office", ".odp": "office",
  ".hwp": "hwp", ".hwpx": "hwp",
};

export function kindFromExtension(ext: string): MediaKind {
  return EXT_KIND[ext.toLowerCase()] ?? "unknown";
}

export function extensionOf(name: string): string {
  const base = name.split(/[?#]/)[0].replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function kindFromName(name: string): MediaKind {
  return kindFromExtension(extensionOf(name));
}

export function fileNameOf(path: string): string {
  const clean = path.split(/[?#]/)[0].replace(/\\/g, "/");
  const base = clean.split("/").pop() || "file";
  try { return decodeURIComponent(base); } catch { return base; }
}
