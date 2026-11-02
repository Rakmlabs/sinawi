import { execFile } from "node:child_process";
import type { Express } from "express";

/**
 * Opens a link from the chat in the user's default browser (or mail app). The app's webview
 * cannot: `target="_blank"` does nothing there. Only web and mail-style links are accepted, so
 * this never launches a local file or app.
 */
export function externalUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 8_000) return undefined;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return undefined; }
  if (!["http:", "https:", "mailto:", "tel:", "sms:", "facetime:"].includes(url.protocol)) return undefined;
  return url.href;
}

export function registerOpenExternalRoute(app: Express, launch = (url: string, done: (error: Error | null) => void) => {
  const [command, args] = process.platform === "darwin" ? ["/usr/bin/open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(command as string, args as string[], (error) => done(error));
}) {
  app.post("/api/open-external", (req, res) => {
    const url = externalUrl(req.body?.url);
    if (!url) { res.status(400).json({ error: "열 수 없는 주소입니다." }); return; }
    launch(url, (error) => error ? res.status(500).json({ error: "기본 브라우저를 열지 못했습니다." }) : res.json({ ok: true }));
  });
}
