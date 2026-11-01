import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentId, SkillInfo } from "./types.js";

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

function userRoots(): SkillRoot[] {
  return [
    { path: join(homedir(), ".claude", "skills"), source: "Claude", agents: ["claude"] },
    { path: join(homedir(), ".codex", "skills"), source: "Codex", agents: ["codex"] },
    { path: join(homedir(), ".codex", "prompts"), source: "Codex 프롬프트", agents: ["codex"] },
    { path: join(homedir(), ".agents", "skills"), source: "Agents", agents: ["codex"] },
    { path: join(homedir(), ".grok", "skills"), source: "Grok Build", agents: ["grok"] },
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

function metadata(content: string, fallback: string) {
  const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallback;
  const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "사용자 정의 에이전트 스킬";
  return { name, description };
}

async function readSkill(file: string, source: string, fallback: string, agents: AgentId[]): Promise<SkillRecord | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 512_000) return undefined;
    const content = await readFile(file, "utf8");
    const meta = metadata(content, fallback);
    const id = createHash("sha256").update(`${source}:${meta.name}`).digest("hex").slice(0, 16);
    return { id, source, ...meta, agents: [...agents], content };
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
    return {
      ...record,
      id: createHash("sha256").update(`${record.source}:${name}`).digest("hex").slice(0, 16),
      name,
    };
  });
}

function dedupe(records: SkillRecord[]): SkillRecord[] {
  const unique = new Map<string, SkillRecord>();
  for (const record of records) {
    const key = `${record.name.toLocaleLowerCase()}\0${record.source.toLocaleLowerCase()}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, record);
      continue;
    }
    existing.agents = [...new Set([...existing.agents, ...record.agents])];
  }
  return [...unique.values()];
}

export async function scanProjectSkills(cwd: string): Promise<SkillRecord[]> {
  return dedupe((await Promise.all(projectRoots(cwd).map((root) =>
    scanSkillRoot(root.path, root.source, root.agents)
  ))).flat());
}

export function clearSkillsCache(cwd?: string): void {
  if (cwd) cache.delete(resolve(cwd));
  else cache.clear();
}

export async function loadSkills(cwd = process.cwd(), refresh = false): Promise<SkillRecord[]> {
  const key = resolve(cwd);
  const cached = cache.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.records;
  const records = dedupe((await Promise.all([
    ...userRoots().map((root) => scanSkillRoot(root.path, root.source, root.agents)),
    scanProjectSkills(key),
    scanClaudePlugins(),
  ])).flat());
  cache.set(key, { expires: Date.now() + 15_000, records });
  return records;
}

export async function publicSkills(cwd?: string, refresh = false): Promise<SkillInfo[]> {
  return (await loadSkills(cwd, refresh)).map(({ content: _content, ...record }) => record);
}

export function filterEnabledSkills<T extends Pick<SkillInfo, "name">>(records: T[], disabledNames: readonly string[] = []): T[] {
  const disabled = new Set(disabledNames.map((name) => name.toLocaleLowerCase()));
  return records.filter((record) => !disabled.has(record.name.toLocaleLowerCase()));
}

export async function enabledPublicSkills(cwd?: string, refresh = false, disabledNames: readonly string[] = []): Promise<SkillInfo[]> {
  return filterEnabledSkills(await publicSkills(cwd, refresh), disabledNames);
}

export async function resolveSkillPrompt(ids: string[], cwd?: string, disabledNames: readonly string[] = []): Promise<string> {
  if (!ids.length) return "";
  return formatSkillPrompt(await loadSkills(cwd), ids, disabledNames);
}

export function formatSkillPrompt(records: SkillRecord[], ids: string[], disabledNames: readonly string[] = []): string {
  const allowed = new Set(ids.slice(0, 20));
  const selected = filterEnabledSkills(records, disabledNames).filter((record) => allowed.has(record.id));
  if (!selected.length) return "";
  const sections: string[] = [];
  let remaining = 60_000;
  for (const skill of selected) {
    const heading = `\n--- ${skill.name} (${skill.source}) ---\n`;
    if (heading.length >= remaining) break;
    const content = skill.content.slice(0, Math.max(0, remaining - heading.length));
    sections.push(`${heading}${content}`);
    remaining -= heading.length + content.length;
    if (remaining <= 0) break;
  }
  return `\n\n선택된 스킬 지침:\n${sections.join("\n")}`;
}
