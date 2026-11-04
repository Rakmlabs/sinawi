import { randomUUID } from "node:crypto";
import { open, readFile, readdir, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentId } from "./types.js";
import { defaultDataDir } from "./runtime.js";

export interface QuotaWindow {
  key: string;
  label: string;
  remainingPercent: number;
  resetsAt?: number;
}

export interface ProviderQuota {
  agent: AgentId;
  windows: QuotaWindow[];
  updatedAt?: string;
  source?: string;
  credits?: Record<string, unknown>;
  unavailableReason?: string;
  /** The CLI account folder these limits are for (a workspace's, server/cli.ts accountEnv); unset: the default login. */
  account?: string;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

function unixSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value > 10_000_000_000 ? value / 1_000 : value);
  if (typeof value !== "string" || !value.trim()) return;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.round(timestamp / 1_000) : undefined;
}

function codexWindow(key: string, value: unknown): QuotaWindow | undefined {
  const window = record(value);
  const used = finite(window?.used_percent ?? window?.usedPercent);
  if (used === undefined) return;
  const minutes = finite(window?.window_minutes ?? window?.windowMinutes);
  const label = minutes !== undefined && minutes <= 360 ? "5시간" : minutes !== undefined && minutes >= 10_000 ? "주간" : key === "primary" ? "5시간" : "주간";
  const resetsAt = unixSeconds(window?.resets_at ?? window?.resetsAt);
  return { key, label, remainingPercent: percent(100 - used), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function claudeWindow(key: string, label: string, value: unknown): QuotaWindow | undefined {
  const window = record(value);
  const utilization = finite(window?.utilization);
  if (utilization === undefined) return;
  const resetsAt = unixSeconds(window?.resetsAt ?? window?.resets_at);
  return { key, label, remainingPercent: percent(100 - utilization * 100), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/** Parses only documented machine-readable quota events. Unrecognized fields are ignored. */
export function parseProviderQuota(agent: AgentId, rawLine: string, updatedAt = new Date().toISOString()): ProviderQuota | undefined {
  let data: Record<string, any> | undefined;
  try { data = record(JSON.parse(rawLine)); } catch { return; }
  if (!data) return;

  if (agent === "codex") {
    const payload = record(data.payload) ?? record(data.event) ?? data;
    const limits = record(payload.rate_limits ?? payload.rateLimits ?? data.rate_limits ?? data.rateLimits);
    if (!limits) return;
    const windows = [["primary", limits.primary], ["secondary", limits.secondary]]
      .map(([key, value]) => codexWindow(key as string, value))
      .filter((value): value is QuotaWindow => Boolean(value));
    if (!windows.length) return;
    return {
      agent,
      windows,
      ...(record(limits.credits) ? { credits: structuredClone(limits.credits) } : {}),
      updatedAt,
      source: "codex-session",
    };
  }

  if (agent === "claude") {
    if (data.type !== "rate_limit_event") return;
    const info = record(data.rate_limit_info ?? data.rateLimitInfo);
    const unified = record(info?.unifiedWindows ?? info?.unified_windows);
    const windows = [
      claudeWindow("five_hour", "5시간", unified?.five_hour ?? unified?.fiveHour),
      claudeWindow("seven_day", "주간", unified?.seven_day ?? unified?.sevenDay),
    ].filter((value): value is QuotaWindow => Boolean(value));
    if (!windows.length && info) {
      const key = String(info.rateLimitType ?? info.rate_limit_type ?? "current");
      const normalized = key.toLowerCase();
      const label = normalized.includes("five") || normalized.includes("5") ? "5시간"
        : normalized.includes("seven") || normalized.includes("7") || normalized.includes("week") ? "주간" : "현재 한도";
      const fallback = claudeWindow(key, label, info);
      if (fallback) windows.push(fallback);
    }
    if (!windows.length) return;
    return { agent, windows, updatedAt, source: "claude-stream" };
  }

  return undefined;
}

const queues = new Map<string, Promise<void>>();

async function readStored(directory: string): Promise<ProviderQuota[]> {
  try {
    const parsed = JSON.parse(await readFile(resolve(directory, "provider-limits.json"), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const providers: ProviderQuota[] = [];
    for (const value of parsed) {
      const item = record(value);
      if (!item || !["codex", "claude", "grok"].includes(item.agent) || !Array.isArray(item.windows)) continue;
      const windows: QuotaWindow[] = [];
      for (const candidate of item.windows) {
        const window = record(candidate);
        const remainingPercent = finite(window?.remainingPercent);
        if (!window || typeof window.key !== "string" || typeof window.label !== "string" || remainingPercent === undefined || remainingPercent < 0 || remainingPercent > 100) continue;
        const resetsAt = finite(window.resetsAt);
        windows.push({ key: window.key, label: window.label, remainingPercent, ...(resetsAt === undefined || resetsAt < 0 ? {} : { resetsAt }) });
      }
      providers.push({
        agent: item.agent,
        windows,
        ...(typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt)) ? { updatedAt: item.updatedAt } : {}),
        ...(typeof item.source === "string" ? { source: item.source } : {}),
        ...(record(item.credits) ? { credits: structuredClone(item.credits) } : {}),
        ...(typeof item.unavailableReason === "string" ? { unavailableReason: item.unavailableReason } : {}),
        ...(typeof item.account === "string" && item.account ? { account: item.account } : {}),
      });
    }
    return providers;
  } catch { return []; }
}

export function saveProviderQuota(quota: ProviderQuota, directory = defaultDataDir): Promise<void> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const providers = await readStored(directory);
    // One entry per agent and account: another workspace's login keeps its own limits.
    const index = providers.findIndex((item) => item.agent === quota.agent && (item.account ?? "") === (quota.account ?? ""));
    if (index >= 0) providers[index] = structuredClone(quota);
    else providers.push(structuredClone(quota));
    const file = resolve(directory, "provider-limits.json");
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(providers, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  });
  queues.set(directory, operation.catch(() => undefined));
  return operation;
}

function isNewer(left?: string, right?: string): boolean {
  const a = left ? Date.parse(left) : 0;
  const b = right ? Date.parse(right) : 0;
  return Number.isFinite(a) && a > (Number.isFinite(b) ? b : 0);
}

const codexScanCache = new Map<string, { expiresAt: number; result: Promise<ProviderQuota | undefined> }>();

async function readTail(file: string, maximumBytes = 2 * 1024 * 1024): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const value = buffer.toString("utf8");
    return info.size > length ? value.slice(Math.max(0, value.indexOf("\n") + 1)) : value;
  } finally { await handle.close(); }
}

async function scanCodexQuotaUncached(codexHome: string): Promise<ProviderQuota | undefined> {
  const root = resolve(codexHome, "sessions");
  let names: string[];
  try { names = (await readdir(root, { recursive: true })).filter((name) => String(name).endsWith(".jsonl")).map(String); }
  catch { return; }
  const ranked = (await Promise.all(names.map(async (name) => {
    try { return { name, modified: (await stat(resolve(root, name))).mtimeMs }; }
    catch { return undefined; }
  }))).filter((value): value is { name: string; modified: number } => Boolean(value))
    .sort((left, right) => right.modified - left.modified)
    .slice(0, 100);
  let latest: ProviderQuota | undefined;
  for (const { name, modified } of ranked) {
    let content: string;
    try { content = await readTail(resolve(root, name)); } catch { continue; }
    const lines = content.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      if (!line.includes("rate_limit")) continue;
      let timestamp: string | undefined;
      try {
        const data = record(JSON.parse(line));
        timestamp = typeof data?.timestamp === "string" ? data.timestamp : typeof data?.time === "string" ? data.time : undefined;
        if (timestamp && !Number.isFinite(Date.parse(timestamp))) timestamp = undefined;
      } catch { continue; }
      const parsed = parseProviderQuota("codex", line, timestamp ?? new Date(modified).toISOString());
      if (parsed && (!latest || isNewer(parsed.updatedAt, latest.updatedAt))) latest = parsed;
    }
  }
  return latest;
}

/**
 * Reads the newest bounded tail of Codex's append-only session events without changing them.
 * `codexHome`: an account folder (CODEX_HOME) in place of `<home>/.codex`.
 */
export function scanCodexQuota(homeDirectory = homedir(), codexHome = resolve(homeDirectory, ".codex")): Promise<ProviderQuota | undefined> {
  const cached = codexScanCache.get(codexHome);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = scanCodexQuotaUncached(codexHome);
  codexScanCache.set(codexHome, { expiresAt: Date.now() + 30_000, result });
  return result;
}

/**
 * The limits of every agent, one entry each. `accounts`: the workspace's CLI account folders; an
 * agent with one reports that account's limits, the others the default login's.
 */
export async function loadProviderQuotas(directory = defaultDataDir, homeDirectory = homedir(), accounts: Partial<Record<AgentId, string>> = {}): Promise<ProviderQuota[]> {
  await (queues.get(directory) ?? Promise.resolve());
  const stored = (await readStored(directory)).filter((item) => (item.account ?? "") === (accounts[item.agent] ?? ""));
  const scanned = await scanCodexQuota(homeDirectory, accounts.codex);
  const codex = scanned && accounts.codex ? { ...scanned, account: accounts.codex } : scanned;
  const byAgent = new Map(stored.map((item) => [item.agent, item]));
  const cachedCodex = byAgent.get("codex");
  if (codex && (!cachedCodex || isNewer(codex.updatedAt, cachedCodex.updatedAt))) byAgent.set("codex", codex);
  if (!byAgent.has("grok")) byAgent.set("grok", { agent: "grok", windows: [], source: "grok-cli", unavailableReason: "남은 한도 정보 제공 안 함" });
  return (["codex", "claude", "grok"] as AgentId[]).map((agent) => byAgent.get(agent) ?? { agent, windows: [] });
}

/** Removes only fresh, known low-quota providers; always leaves at least one candidate. */
export function quotaEligibleAgents(agents: AgentId[], providers: ProviderQuota[], now = new Date()): AgentId[] {
  const low = new Set(providers.filter((provider) => {
    const updated = provider.updatedAt ? Date.parse(provider.updatedAt) : NaN;
    return Number.isFinite(updated) && now.getTime() - updated <= 24 * 60 * 60 * 1_000 && now.getTime() >= updated - 5 * 60 * 1_000
      && provider.windows.some((window) => window.remainingPercent < 10 && (window.resetsAt === undefined || window.resetsAt * 1_000 > now.getTime()));
  }).map((provider) => provider.agent));
  const eligible = agents.filter((agent) => !low.has(agent));
  return eligible.length ? eligible : agents;
}
