import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentId, SkillInfo, WorkspaceAccounts } from "./types.js";
import { ACCOUNT_ENV } from "./workspace-policy.js";

export interface SkillRecord extends SkillInfo {
  agents: AgentId[];
  content: string;
}

interface SkillRoot {
  path: string;
  source: string;
  agents: AgentId[];
}

const cache = new Map<string, { expires: number; records: SkillRecord[] }>();
const allAgents: AgentId[] = ["claude", "codex", "grok"];
const canonicalFiles = new WeakMap<SkillRecord, string>();

/** `accounts`: a workspace's CLI account folders; their skills replace the default login's. */
function userRoots(accounts: WorkspaceAccounts = {}): SkillRoot[] {
  const claude = accounts.claude!;
  const codex = accounts.codex!;
  const grok = accounts.grok!;
  return [
    { path: join(claude, "skills"), source: "Claude", agents: ["claude"] },
    { path: join(codex, "skills"), source: "Codex", agents: ["codex"] },
    { path: join(codex, "prompts"), source: "Codex 프롬프트", agents: ["codex"] },
    { path: join(homedir(), ".agents", "skills"), source: "Agents", agents: ["codex"] },
    { path: join(grok, "skills"), source: "Grok Build", agents: ["grok"] },
    { path: resolve(process.cwd(), "skills"), source: "로컬", agents: allAgents },
  ];
}

function projectRoots(cwd: string): SkillRoot[] {
  return [
    { path: resolve(cwd, ".claude", "skills"), source: "프로젝트", agents: ["claude"] },
    { path: resolve(cwd, ".agents", "skills"), source: "프로젝트", agents: ["codex"] },
    { path: resolve(cwd, ".codex", "skills"), source: "프로젝트", agents: ["codex"] },
  ];
}

function yamlDescription(content: string): string | undefined {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^description:\s*/u.test(line));
  if (index < 0) return;
  const value = lines[index].replace(/^description:\s*/u, "").trim();
  if (!/^[|>][+-]?$/u.test(value)) return value || undefined;
  const body: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "---" || (line.trim() && !/^\s/u.test(line))) break;
    body.push(line);
  }
  const indentation = Math.min(...body.filter((line) => line.trim()).map((line) => line.match(/^\s*/u)![0].length));
  const block = body.map((line) => line.slice(Math.min(indentation, line.length))).join("\n").trim();
  return value.startsWith(">") ? block.replace(/([^\n])\n(?=[^\n])/gu, "$1 ") : block;
}

function metadata(content: string, fallback: string) {
  const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallback;
  const description = yamlDescription(content) || "사용자 정의 에이전트 스킬";
  return { name, description };
}

async function readSkill(file: string, source: string, fallback: string, agents: AgentId[]): Promise<SkillRecord | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 512_000) return undefined;
    const content = await readFile(file, "utf8");
    const meta = metadata(content, fallback);
    const id = createHash("sha256").update(`${source}:${meta.name}`).digest("hex").slice(0, 16);
    const record = { id, source, ...meta, agents: [...agents], content };
    try { canonicalFiles.set(record, await realpath(file)); } catch { /* name and source remain the fallback identity */ }
    return record;
  } catch {
    return undefined;
  }
}

/** Scan direct Markdown commands and SKILL.md files nested at most three directories deep. */
export async function scanSkillRoot(path: string, source: string, agents: AgentId[] = allAgents): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  const visited = new Set<string>();

  async function walk(directory: string, depth: number): Promise<void> {
    let canonical: string;
    let entries;
    try {
      canonical = await realpath(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.slice(0, 300).map(async (entry) => {
      const candidate = join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(candidate);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          return;
        }
      }
      if (isDirectory) {
        if (depth < 3) await walk(candidate, depth + 1);
        return;
      }
      if (!isFile || !/\.(md|txt)$/i.test(entry.name)) return;
      if (depth > 0 && entry.name.toLocaleLowerCase() !== "skill.md") return;
      const fallback = entry.name.toLocaleLowerCase() === "skill.md"
        ? basename(dirname(candidate))
        : basename(entry.name, ".md");
      const record = await readSkill(candidate, source, fallback, agents);
      if (record) records.push(record);
    }));
  }

  await walk(path, 0);
  return records;
}

interface InstalledPlugin {
  installPath?: unknown;
}

/** Read Claude's plugin registry and discover each installed plugin's skills and commands. */
export async function scanClaudePlugins(registryPath = join(homedir(), ".claude", "plugins", "installed_plugins.json")): Promise<SkillRecord[]> {
  let plugins: Record<string, InstalledPlugin[]>;
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as { plugins?: Record<string, InstalledPlugin[]> };
    plugins = parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : {};
  } catch {
    return [];
  }

  const scans: Promise<SkillRecord[]>[] = [];
  for (const [qualifiedName, installs] of Object.entries(plugins)) {
    const source = qualifiedName.split("@")[0] || qualifiedName;
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      if (typeof install?.installPath !== "string") continue;
      scans.push(scanSkillRoot(join(install.installPath, "skills"), source, ["claude"]));
      scans.push(scanSkillRoot(join(install.installPath, "commands"), source, ["claude"]));
    }
  }
  return (await Promise.all(scans)).flat().map((record) => {
    const name = record.name.replace(/^omc-/, "");
    if (name === record.name) return record;
    record.id = createHash("sha256").update(`${record.source}:${name}`).digest("hex").slice(0, 16);
    record.name = name;
    return record;
  });
}

function dedupe(records: SkillRecord[]): SkillRecord[] {
  const unique = new Map<string, SkillRecord>();
  for (const record of records) {
    const key = canonicalFiles.get(record) ?? `${record.name.toLocaleLowerCase()}\0${record.source.toLocaleLowerCase()}`;
    const existing = unique.get(key);
    if (existing) {
      existing.agents = [...new Set([...existing.agents, ...record.agents])];
      continue;
    }
    unique.set(key, record);
  }
  const collisions = new Map<string, Array<[string, SkillRecord]>>();
  for (const entry of unique) collisions.set(entry[1].id, [...(collisions.get(entry[1].id) ?? []), entry]);
  const usedIds = new Set(collisions.keys());
  for (const [id, entries] of collisions) {
    for (const [key, record] of entries.sort(([left], [right]) => left.localeCompare(right)).slice(1)) {
      let suffix = 0;
      do {
        record.id = createHash("sha256").update(`${id}\0${key}\0${suffix}`).digest("hex").slice(0, 16);
        suffix += 1;
      } while (usedIds.has(record.id));
      usedIds.add(record.id);
    }
  }
  return [...unique.values()];
}

export async function scanProjectSkills(cwd: string): Promise<SkillRecord[]> {
  return dedupe((await Promise.all(projectRoots(cwd).map((root) =>
    scanSkillRoot(root.path, root.source, root.agents)
  ))).flat());
}

export function clearSkillsCache(cwd?: string): void {
  if (!cwd) { cache.clear(); return; }
  const folder = resolve(cwd);
  for (const key of cache.keys()) if (key === folder || key.startsWith(`${folder}\0`)) cache.delete(key);
}

const effectiveAccounts = (accounts: WorkspaceAccounts = {}): WorkspaceAccounts => Object.fromEntries(
  (["claude", "codex", "grok"] as const).map((agent) => [agent, accounts[agent] ?? process.env[ACCOUNT_ENV[agent]] ?? join(homedir(), `.${agent}`)])
);
const accountsKey = (accounts: WorkspaceAccounts) => (["claude", "codex", "grok"] as const).map((agent) => accounts[agent]).join("\0");

/** `accounts`: the workspace's CLI account folders (user skills and Claude plugins are read from them). */
export async function loadSkills(cwd = process.cwd(), refresh = false, accounts: WorkspaceAccounts = {}): Promise<SkillRecord[]> {
  const folder = resolve(cwd);
  const effective = effectiveAccounts(accounts);
  const key = `${folder}\0${accountsKey(effective)}`;
  const cached = cache.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.records;
  const records = dedupe((await Promise.all([
    ...userRoots(effective).map((root) => scanSkillRoot(root.path, root.source, root.agents)),
    scanProjectSkills(folder),
    scanClaudePlugins(join(effective.claude!, "plugins", "installed_plugins.json")),
  ])).flat());
  cache.set(key, { expires: Date.now() + 15_000, records });
  return records;
}

export async function publicSkills(cwd?: string, refresh = false, accounts?: WorkspaceAccounts): Promise<SkillInfo[]> {
  return (await loadSkills(cwd, refresh, accounts)).map(({ content: _content, ...record }) => record);
}

export function filterEnabledSkills<T extends Pick<SkillInfo, "name">>(records: T[], disabledNames: readonly string[] = []): T[] {
  const disabled = new Set(disabledNames.map((name) => name.toLocaleLowerCase()));
  return records.filter((record) => !disabled.has(record.name.toLocaleLowerCase()));
}

export async function enabledPublicSkills(cwd?: string, refresh = false, disabledNames: readonly string[] = [], accounts?: WorkspaceAccounts): Promise<SkillInfo[]> {
  return filterEnabledSkills(await publicSkills(cwd, refresh, accounts), disabledNames);
}

export async function resolveSkillPrompt(ids: string[], cwd?: string, disabledNames: readonly string[] = [], accounts?: WorkspaceAccounts): Promise<string> {
  if (!ids.length) return "";
  return formatSkillPrompt(await loadSkills(cwd, false, accounts), ids, disabledNames);
}

export function formatSkillPrompt(records: SkillRecord[], ids: string[], disabledNames: readonly string[] = []): string {
  return formatSkillInstructions(records, ids, disabledNames).text;
}

export function formatSkillInstructions(records: SkillRecord[], ids: string[], disabledNames: readonly string[] = []): { text: string; attachedSkills: string[] } {
  const allowed = new Set(ids.slice(0, 20));
  const selected = filterEnabledSkills(records, disabledNames).filter((record) => allowed.has(record.id));
  if (!selected.length) return { text: "", attachedSkills: [] };
  const sections: string[] = [];
  const attachedSkills: string[] = [];
  let remaining = 60_000;
  for (const skill of selected) {
    const heading = `\n--- ${skill.name} (${skill.source}) ---\n`;
    if (heading.length >= remaining) break;
    const content = skill.content.slice(0, Math.max(0, remaining - heading.length));
    sections.push(`${heading}${content}`);
    if (content) attachedSkills.push(skill.name);
    remaining -= heading.length + content.length;
    if (remaining <= 0) break;
  }
  return { text: `\n\n선택된 스킬 지침:\n${sections.join("\n")}`, attachedSkills };
}
