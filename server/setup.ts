import { fullPath, resolveCli } from "./cli-path";
/** 설정 도우미(first-run onboarding): tool versions, login state, macOS permissions. No user-specific paths. */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import type { Express, Request, Response } from "express";

export type SetupToolId = "node" | "npm" | "git" | "claude" | "codex" | "grok";
export type SetupTool = { id: SetupToolId; name: string; agent: boolean; installed: boolean; version?: string; install: string; docs: string; login?: string };
export type PermissionId = "notifications" | "screen" | "accessibility" | "files";
export type PermissionState = "granted" | "denied" | "unknown";

export const SETUP_TOOLS: ReadonlyArray<Omit<SetupTool, "installed" | "version">> = [
  { id: "node", name: "Node.js", agent: false, install: "brew install node", docs: "https://nodejs.org/ko/download" },
  { id: "npm", name: "npm", agent: false, install: "brew install node", docs: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm" },
  { id: "git", name: "Git", agent: false, install: "xcode-select --install", docs: "https://git-scm.com/downloads/mac" },
  { id: "claude", name: "Claude Code", agent: true, install: "curl -fsSL https://claude.ai/install.sh | bash", docs: "https://docs.anthropic.com/ko/docs/claude-code/setup", login: "claude auth login" },
  { id: "codex", name: "Codex CLI", agent: true, install: "npm install -g @openai/codex", docs: "https://github.com/openai/codex", login: "codex login" },
  { id: "grok", name: "Grok Build", agent: true, install: "curl -fsSL https://x.ai/cli/install.sh | bash", docs: "https://docs.x.ai/build/overview", login: "grok login" },
];

/** System Settings deep links (only these may be opened). */
export const SETTINGS_PANES: Record<PermissionId, string> = {
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  files: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

/** Common install locations, so a CLI installed after the app started is still found. */
export function searchPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env === process.env && home === homedir()) return fullPath();
  const extra = [join(home, ".local/bin"), join(home, ".grok/bin"), join(home, ".npm-global/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

export function parseVersion(output: string): string | undefined {
  return output.match(/v?(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*)/)?.[1];
}

type Runner = (command: string, args: string[]) => Promise<string>;
const defaultRunner: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(resolveCli(command) ?? command, args, { timeout: 8000, env: { ...process.env, PATH: searchPath() } }, (error, stdout, stderr) => error ? reject(error) : resolve(`${stdout}\n${stderr}`));
});

const binary = (id: SetupToolId) => ({ claude: process.env.AGENT_ORCHESTRA_CLAUDE_BIN, codex: process.env.AGENT_ORCHESTRA_CODEX_BIN, grok: process.env.AGENT_ORCHESTRA_GROK_BIN } as Record<string, string | undefined>)[id] || id;

export async function detectTools(run: Runner = defaultRunner): Promise<SetupTool[]> {
  return Promise.all(SETUP_TOOLS.map(async (tool) => {
    // `xcode-select` stub git exists on every Mac; it fails until the command line tools are installed.
    try { const version = parseVersion(await run(binary(tool.id), ["--version"])); return { ...tool, installed: true, version }; }
    catch { return { ...tool, installed: false }; }
  }));
}

/** Only what can be read without prompting: Full Disk Access is visible by trying a protected file. */
export async function detectPermissions(home = homedir()): Promise<Record<PermissionId, PermissionState>> {
  let files: PermissionState = "unknown";
  if (platform() === "darwin") {
    try { await access(join(home, "Library/Application Support/com.apple.TCC/TCC.db"), constants.R_OK); files = "granted"; }
    catch (error) { files = (error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES" ? "denied" : "unknown"; }
  }
  return { notifications: "unknown", screen: "unknown", accessibility: "unknown", files };
}

export function registerSetupRoutes(app: Express, run: Runner = defaultRunner) {
  app.get("/api/setup", async (_req: Request, res: Response) => {
    try { res.json({ platform: platform(), tools: await detectTools(run), permissions: await detectPermissions() }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/setup/open-settings", (req: Request, res: Response) => {
    const pane = SETTINGS_PANES[req.body?.pane as PermissionId];
    if (!pane) { res.status(400).json({ error: "알 수 없는 설정 화면입니다." }); return; }
    if (platform() !== "darwin") { res.status(400).json({ error: "macOS에서만 열 수 있습니다." }); return; }
    execFile("open", [pane], (error) => error ? res.status(500).json({ error: "시스템 설정을 열지 못했습니다." }) : res.status(204).end());
  });
}
