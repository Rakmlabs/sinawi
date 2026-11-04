import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Express, Request, Response } from "express";
import { resolveCli } from "./cli-path.js";
import { extensionOf, fileNameOf, kindFromExtension, type MediaKind } from "./media-kinds.js";

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
};

const FILE_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8", ".ini": "text/plain; charset=utf-8", ".xml": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".markdown": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".tsv": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".tsx": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".cjs": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8", ".rs": "text/plain; charset=utf-8", ".go": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8", ".css": "text/plain; charset=utf-8", ".html": "text/plain; charset=utf-8", ".htm": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8", ".sql": "text/plain; charset=utf-8", ".rb": "text/plain; charset=utf-8",
  ".php": "text/plain; charset=utf-8", ".swift": "text/plain; charset=utf-8", ".kt": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8", ".h": "text/plain; charset=utf-8", ".cpp": "text/plain; charset=utf-8",
  ".hpp": "text/plain; charset=utf-8", ".cs": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".hwp": "application/x-hwp", ".hwpx": "application/vnd.hancom.hwpx",
};

export type ResolvedFile = { file: string; type: string; kind: MediaKind };

function inside(root: string, file: string) {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

async function resolveInside(cwd: string, requested: string, extraRoots: string[]): Promise<string> {
  if (requested.includes("\0")) throw httpError("경로가 올바르지 않습니다.", 400);
  const raw = requested.replace(/^file:\/\//, "").split(/[?#]/)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  if (!decoded || decoded.includes("\0")) throw httpError("경로가 올바르지 않습니다.", 400);
  const file = await realpath(isAbsolute(decoded) ? decoded : resolve(cwd, decoded)).catch(() => { throw httpError("파일이 없습니다.", 404); });
  const roots = await Promise.all([cwd, ...extraRoots].map((root) => realpath(root).catch(() => undefined)));
  if (!roots.some((root) => root && inside(root, file))) throw httpError("작업 폴더 밖의 파일입니다.", 403);
  if (!(await stat(file)).isFile()) throw httpError("파일이 아닙니다.", 404);
  return file;
}

/** Resolve an image path from chat markdown. Symlinks are resolved before the root check. */
export async function resolveSessionImage(cwd: string, requested: string, extraRoots: string[] = []): Promise<{ file: string; type: string }> {
  const raw = requested.replace(/^file:\/\//, "").split(/[?#]/)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  const type = IMAGE_TYPES[extname(decoded).toLowerCase()];
  if (!type) throw httpError("이미지 파일만 열 수 있습니다.", 415);
  const file = await resolveInside(cwd, requested, extraRoots);
  return { file, type };
}

/** Same root rules as images, for every viewable kind. HTML is served as plain text. */
export async function resolveSessionFile(cwd: string, requested: string, extraRoots: string[] = []): Promise<ResolvedFile> {
  const raw = requested.replace(/^file:\/\//, "").split(/[?#]/)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  const ext = extname(decoded).toLowerCase();
  const type = FILE_TYPES[ext];
  const kind = kindFromExtension(ext);
  if (!type || kind === "unknown") throw httpError("이 형식은 미리볼 수 없습니다.", 415);
  const file = await resolveInside(cwd, requested, extraRoots);
  return { file, type, kind };
}

export async function readTextPreview(file: string, maxBytes = 512 * 1024): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(Number(info.size), maxBytes);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, 0);
    let text = buffer.toString("utf8");
    if (info.size > maxBytes) text = text.replace(/\uFFFD$/, "");
    return { text, truncated: info.size > maxBytes };
  } finally { await handle.close(); }
}

export type FileAction = "reveal" | "open" | "quicklook";

export function fileActionCommand(action: FileAction, file: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") {
    if (action === "reveal") return { command: "/usr/bin/open", args: ["-R", file] };
    if (action === "quicklook") return { command: "/usr/bin/qlmanage", args: ["-p", file] };
    return { command: "/usr/bin/open", args: [file] };
  }
  if (platform === "win32") {
    if (action === "reveal") return { command: "explorer", args: ["/select,", file] };
    return { command: "cmd", args: ["/c", "start", "", file] };
  }
  return { command: "xdg-open", args: [action === "reveal" ? dirname(file) : file] };
}

function canExec(file: string): boolean {
  try { accessSync(file, fsConstants.X_OK); return true; } catch { return false; }
}

export function defaultOfficeCandidates(platform = process.platform, home = homedir()): string[] {
  if (platform !== "darwin") return [];
  return ["/Applications/LibreOffice.app/Contents/MacOS/soffice", join(home, "Applications/LibreOffice.app/Contents/MacOS/soffice")];
}

export function officeConverter(options: {
  lookup?: (name: string) => string | undefined;
  platform?: NodeJS.Platform;
  home?: string;
  candidates?: string[];
} = {}): string | undefined {
  const lookup = options.lookup ?? ((name: string) => resolveCli(name));
  const fromPath = lookup("soffice") ?? lookup("libreoffice");
  if (fromPath) return fromPath;
  const candidates = options.candidates ?? defaultOfficeCandidates(options.platform ?? process.platform, options.home ?? homedir());
  return candidates.find((file) => canExec(file));
}

export function conversionArgs(binary: string, file: string, outDir: string, profileDir: string): { command: string; args: string[] } {
  return {
    command: binary,
    args: ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(profileDir).href}`, "--convert-to", "pdf", "--outdir", outDir, file],
  };
}

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<void>;

export async function convertToPdf(source: string, cacheDir: string, binary: string, run: CommandRunner): Promise<string> {
  const info = await stat(source);
  const key = createHash("sha256").update(`${source}\0${info.mtimeMs}\0${info.size}`).digest("hex").slice(0, 24);
  const dir = join(cacheDir, key);
  const pdf = join(dir, "preview.pdf");
  try { if ((await stat(pdf)).isFile() && (await stat(pdf)).size > 0) return pdf; } catch { /* cache miss */ }
  await mkdir(dir, { recursive: true });
  const profile = join(dir, "profile");
  await mkdir(profile, { recursive: true });
  const spec = conversionArgs(binary, source, dir, profile);
  await run(spec.command, spec.args, 90_000);
  const produced = join(dir, `${basename(source, extname(source))}.pdf`);
  if (produced !== pdf) await rename(produced, pdf);
  if (!(await stat(pdf).catch(() => undefined))?.isFile()) throw httpError("PDF로 바꾸지 못했습니다.", 422);
  return pdf;
}

function contentDisposition(name: string, download: boolean) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function queryPath(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4_096) throw httpError("경로가 올바르지 않습니다.", 400);
  return raw;
}

function sendResolved(res: Response, resolved: ResolvedFile, download: boolean) {
  const name = fileNameOf(resolved.file);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "private, no-cache");
  res.setHeader("content-disposition", contentDisposition(name, download));
  res.type(resolved.type);
  if (resolved.kind === "image" && extensionOf(name) === ".svg") res.setHeader("content-security-policy", "sandbox; default-src 'none'");
  res.sendFile(resolved.file, { dotfiles: "allow" });
}

async function previewPdf(resolved: ResolvedFile, cacheDir: string, converter: string | undefined, run: CommandRunner): Promise<string> {
  if (resolved.kind === "pdf") return resolved.file;
  if (resolved.kind !== "office" && resolved.kind !== "hwp") throw httpError("PDF로 볼 수 없는 파일입니다.", 415);
  if (!converter) throw Object.assign(httpError("PDF로 바꿀 프로그램이 없습니다. Quick Look으로 열 수 있습니다.", 422), { quickLook: true, reason: "no-converter" });
  try { return await convertToPdf(resolved.file, cacheDir, converter, run); }
  catch (error) {
    if ((error as { status?: number }).status === 422 && (error as { quickLook?: boolean }).quickLook) throw error;
    throw Object.assign(httpError("PDF로 바꾸지 못했습니다. Quick Look으로 열 수 있습니다.", 422), { quickLook: true, reason: "failed" });
  }
}

function fail(res: Response, error: unknown) {
  const status = (error as { status?: number }).status ?? 400;
  const body: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error) };
  if ((error as { quickLook?: boolean }).quickLook) body.quickLook = true;
  if ((error as { reason?: string }).reason) body.reason = (error as { reason: string }).reason;
  res.status(status).json(body);
}

export type SessionFolders = { cwd: string; worktrees?: Array<{ path: string }> };

export type SessionFileDeps = {
  lookup?: (id: string) => SessionFolders | undefined;
  /** Folders besides the session's own it may show files from (uploads, its workers' worktrees, screenshots). */
  extraRoots?: (session?: SessionFolders) => string[];
  previewRoot?: () => string;
  cacheDir: () => string;
  converter?: () => string | undefined;
  run?: CommandRunner;
  launch?: (command: string, args: string[]) => void;
  /** Where "download" copies files (default ~/Downloads). */
  downloadsDir?: () => string;
};

function defaultLaunch(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => { /* the UI still offers download */ });
  child.unref();
}

async function defaultRun(command: string, args: string[], timeoutMs: number) {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(command, args, { timeout: timeoutMs }, (error) => error ? rejectRun(error) : resolveRun());
  });
}

async function handleGet(req: Request, res: Response, cwd: string, extraRoots: string[], deps: SessionFileDeps) {
  const resolved = await resolveSessionFile(cwd, queryPath(req.query.path), extraRoots);
  if (req.query.meta === "1") {
    const info = await stat(resolved.file);
    res.json({ name: fileNameOf(resolved.file), size: info.size, kind: resolved.kind, type: resolved.type, path: resolved.file });
    return;
  }
  if (req.query.text === "1") {
    if (!["text", "code", "markdown", "csv"].includes(resolved.kind)) throw httpError("텍스트로 열 수 없는 파일입니다.", 415);
    const preview = await readTextPreview(resolved.file);
    res.json({ ...preview, kind: resolved.kind, name: fileNameOf(resolved.file) });
    return;
  }
  if (req.query.preview === "pdf") {
    const binary = deps.converter ? deps.converter() : officeConverter();
    const pdf = await previewPdf(resolved, deps.cacheDir(), binary, deps.run ?? defaultRun);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", contentDisposition("preview.pdf", false));
    res.sendFile(pdf, { dotfiles: "allow" });
    return;
  }
  sendResolved(res, resolved, req.query.download === "1");
}

/** Copies `file` into `dir` without overwriting: "a.png", then "a (1).png", "a (2).png"… */
export async function copyToDownloads(file: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = extname(file), stem = basename(file, ext);
  for (let n = 0; n < 1000; n++) {
    const target = join(dir, n ? `${stem} (${n})${ext}` : `${stem}${ext}`);
    try { await copyFile(file, target, fsConstants.COPYFILE_EXCL); return target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw httpError("같은 이름의 파일이 너무 많습니다.", 409);
}

function handleOpen(req: Request, res: Response, cwd: string, extraRoots: string[], deps: SessionFileDeps) {
  const action = req.body?.action;
  if (action !== "reveal" && action !== "open" && action !== "quicklook" && action !== "download") throw httpError("열기 동작이 올바르지 않습니다.", 400);
  return resolveSessionFile(cwd, queryPath(req.body?.path), extraRoots).then(async (resolved) => {
    // The app's webview has no download handler, so "download" copies into ~/Downloads and shows it.
    if (action === "download") {
      const saved = await copyToDownloads(resolved.file, deps.downloadsDir?.() ?? join(homedir(), "Downloads"));
      const spec = fileActionCommand("reveal", saved);
      (deps.launch ?? defaultLaunch)(spec.command, spec.args);
      res.json({ ok: true, path: saved });
      return;
    }
    const spec = fileActionCommand(action, resolved.file);
    (deps.launch ?? defaultLaunch)(spec.command, spec.args);
    res.json({ ok: true });
  });
}

export function registerSessionFileRoutes(app: Express, deps: SessionFileDeps) {
  const extra = (session?: SessionFolders) => deps.extraRoots?.(session) ?? [];
  if (deps.lookup) {
    app.get("/api/sessions/:id/file", async (req, res) => {
      try {
        const session = deps.lookup?.(String(req.params.id));
        if (!session) { res.status(404).json({ error: "세션을 찾을 수 없습니다." }); return; }
        await handleGet(req, res, session.cwd, extra(session), deps);
      } catch (error) { fail(res, error); }
    });
    app.post("/api/sessions/:id/file/open", async (req, res) => {
      try {
        const session = deps.lookup?.(String(req.params.id));
        if (!session) { res.status(404).json({ error: "세션을 찾을 수 없습니다." }); return; }
        await handleOpen(req, res, session.cwd, extra(session), deps);
      } catch (error) { fail(res, error); }
    });
  }
  if (deps.previewRoot) {
    app.get("/api/preview/file", async (req, res) => {
      try { await handleGet(req, res, deps.previewRoot!(), [], deps); }
      catch (error) { fail(res, error); }
    });
    app.post("/api/preview/file/open", async (req, res) => {
      try { await handleOpen(req, res, deps.previewRoot!(), [], deps); }
      catch (error) { fail(res, error); }
    });
  }
}

