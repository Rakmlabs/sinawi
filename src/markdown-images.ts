import { createContext } from "react";

/** Session whose work folder relative/absolute image paths in markdown resolve against. */
export const MarkdownSessionContext = createContext<string | undefined>(undefined);

export function localImageSrc(src: string | undefined, sessionId: string | undefined): string | undefined {
  if (!src) return src;
  if (/^(?:https?:|data:|blob:|\/api\/)/i.test(src) || src.startsWith("//")) return src;
  if (!sessionId) return src;
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(src.replace(/^file:\/\//, ""))}`;
}
