import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tableKey = (name: string) => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

function tableHeader(name: string): RegExp {
  const key = escapeRegex(name);
  return new RegExp(`^[ \\t]*\\[[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*\\][^\\r\\n]*(?:\\r?\\n|$)`, "m");
}

/** Body of `[mcp_servers.<name>]` in a TOML text, without the header. */
function tableBody(text: string, name: string): string | undefined {
  const header = tableHeader(name).exec(text);
  if (header?.index === undefined) return undefined;
  const remaining = text.slice(header.index + header[0].length);
  const nextHeader = /^[ \t]*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/m.exec(remaining);
  return remaining.slice(0, nextHeader?.index ?? remaining.length);
}

/**
 * The deny table for one server. Grok needs to know where the server is to match the project entry
 * with the user's one, so its `url`/`command`/`args` lines are copied from the user config (never `env`).
 */
function denyTable(name: string, userConfig: string): string {
  const body = tableBody(userConfig, name) ?? "";
  const location = body.split(/\r?\n/u).filter((line) => /^[ \t]*(?:url|command|args)[ \t]*=/u.test(line)).map((line) => `${line.trim()}\n`).join("");
  return `[mcp_servers.${tableKey(name)}]\n${location}enabled = false\n`;
}

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

function guardedConfig(existing: string, name: string, table: string): string {
  const header = tableHeader(name).exec(existing);
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
    return existing.slice(0, header.index) + table + body.slice(preservedSuffix) + existing.slice(bodyEnd);
  }
  if (!existing) return table;
  return `${existing}${existing.endsWith("\n") ? "\n" : "\n\n"}${table}`;
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

/**
 * Installs the project-level Grok config that turns off the MCP servers a workspace locks.
 * `--deny` alone does not stop Grok from connecting to a server, so the run also disables it here.
 */
export async function ensureGrokMcpGuard(cwd: string, names: readonly string[], options: { userConfigPath?: string } = {}): Promise<void> {
  if (!names.length) return;
  const absoluteCwd = resolve(cwd);
  const git = await findGitRoot(absoluteCwd);
  const root = git?.root ?? absoluteCwd;
  const configPath = join(root, ".grok", "config.toml");
  const currentConfig = await optionalText(configPath);
  const userConfig = await optionalText(options.userConfigPath ?? join(homedir(), ".grok", "config.toml")).catch(() => "");
  let nextConfig = currentConfig;
  for (const name of names) nextConfig = guardedConfig(nextConfig, name, denyTable(name, userConfig));
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
