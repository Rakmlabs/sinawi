import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

const bbananaTable = '[mcp_servers.bbanana]\nurl = "https://www.bbanana.ai/mcp"\nenabled = false\n';

async function gitEntryKind(directory: string): Promise<"directory" | "file" | undefined> {
  try {
    const entry = await lstat(join(directory, ".git"));
    return entry.isDirectory() ? "directory" : entry.isFile() ? "file" : undefined;
  } catch { return undefined; }
}

async function findGitRoot(cwd: string): Promise<{ root: string; gitDirectory: boolean } | undefined> {
  let current = cwd;
  while (true) {
    const kind = await gitEntryKind(current);
    if (kind) return { root: current, gitDirectory: kind === "directory" };
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
}

function guardedConfig(existing: string): string {
  const header = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:bbanana|"bbanana"|'bbanana')[ \t]*\][^\r\n]*(?:\r?\n|$)/m.exec(existing);
  if (header?.index !== undefined) {
    const bodyStart = header.index + header[0].length;
    const remaining = existing.slice(bodyStart);
    const nextHeader = /^[ \t]*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/m.exec(remaining);
    const bodyEnd = bodyStart + (nextHeader?.index ?? remaining.length);
    const body = existing.slice(bodyStart, bodyEnd);
    let preservedSuffix = 0;
    const lines = body.matchAll(/[^\r\n]*(?:\r?\n|$)/g);
    for (const line of lines) {
      if (!line[0]) continue;
      const value = line[0].replace(/\r?\n$/u, "").trim();
      if (value && !value.startsWith("#")) preservedSuffix = (line.index ?? 0) + line[0].length;
    }
    return existing.slice(0, header.index) + bbananaTable + body.slice(preservedSuffix) + existing.slice(bodyEnd);
  }
  if (!existing) return bbananaTable;
  return `${existing}${existing.endsWith("\n") ? "\n" : "\n\n"}${bbananaTable}`;
}

function withLocalExclude(existing: string): string {
  if (existing.split(/\r?\n/u).some((line) => line.trim() === ".grok/")) return existing;
  return `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}.grok/\n`;
}

async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Installs the project-level bbanana deny config used for every company Grok run. */
export async function ensureCompanyGrokGuard(cwd: string): Promise<void> {
  const absoluteCwd = resolve(cwd);
  const git = await findGitRoot(absoluteCwd);
  const root = git?.root ?? absoluteCwd;
  const configPath = join(root, ".grok", "config.toml");
  const currentConfig = await optionalText(configPath);
  const nextConfig = guardedConfig(currentConfig);
  if (nextConfig !== currentConfig) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, nextConfig);
  }

  if (!git?.gitDirectory) return;
  const excludePath = join(root, ".git", "info", "exclude");
  const currentExclude = await optionalText(excludePath);
  const nextExclude = withLocalExclude(currentExclude);
  if (nextExclude !== currentExclude) {
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, nextExclude);
  }
}
