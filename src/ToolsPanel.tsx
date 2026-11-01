import { useEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole, Search, SlidersHorizontal, Wrench } from "lucide-react";
import type { WorkspaceId } from "../server/types";
import { AgentMark } from "./AgentMark";
import { openTerminal } from "./terminal-events";

export type McpTool = {
  agent: string;
  name: string;
  url?: string;
  command?: string;
  "url/command"?: string;
  nativeEnabled: boolean;
  appEnabled: boolean;
  status: string;
  forcedOff?: boolean;
  reason?: string;
  needsAuth?: boolean;
  displayName?: string;
  authCommand?: string;
  authHint?: string;
};

export type ManagedSkill = {
  name: string;
  source: string;
  agents: string[];
  description: string;
  enabled: boolean;
};

export type ToolsState = { mcp: McpTool[]; skills: ManagedSkill[] };
type ToolTab = "mcp" | "skills";
type ToolRow = McpTool | ManagedSkill;

const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude", grok: "Grok Build" };
const statusLabels: Record<string, string> = {
  enabled: "사용 중",
  disabled: "사용 안 함",
  connected: "연결됨",
  disconnected: "연결 안 됨",
  "app-disabled": "앱에서 사용 안 함",
  unavailable: "CLI 없음",
  error: "확인 실패",
  "app-level": "앱에서 관리",
};

function workspaceParam(workspaceId: WorkspaceId) {
  return workspaceId === "company" ? "work" : "personal";
}

export function toolsListPath(workspaceId: WorkspaceId, cwd: string) {
  return `/api/tools?workspace=${workspaceParam(workspaceId)}&cwd=${encodeURIComponent(cwd)}`;
}

export function toolUpdateRequest(workspaceId: WorkspaceId, cwd: string, kind: "mcp" | "skill", name: string, enabled: boolean, agent?: string) {
  return {
    path: `/api/tools/${kind}`,
    init: {
      method: "PUT",
      body: JSON.stringify({ name, enabled, workspace: workspaceParam(workspaceId), cwd, ...(agent ? { agent } : {}) }),
    },
  };
}

export function toolStatusPresentation(tool: McpTool): { label: string; tone: string } {
  if (tool.forcedOff || tool.status === "locked") return { label: "잠김", tone: "locked" };
  if (tool.needsAuth && tool.appEnabled && tool.nativeEnabled) return { label: "인증 필요", tone: "error" };
  if (tool.agent === "claude") {
    if (tool.status === "disconnected") return { label: "연결 안 됨 · 앱에서 관리", tone: "error" };
    if (tool.status === "app-disabled") return { label: "앱에서 사용 안 함", tone: "disabled" };
    return { label: "연결됨 · 앱에서 관리", tone: "enabled" };
  }
  const tone = tool.status === "connected" ? "enabled" : tool.status === "disconnected" ? "error" : tool.status;
  return { label: statusLabels[tool.status] ?? tool.status, tone };
}

export function createRequestGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
    invalidate: () => { generation += 1; },
  };
}

export function toolsShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.altKey) return false;
  if (event.key === "F3") return !event.metaKey && !event.ctrlKey && !event.shiftKey;
  return event.key.toLocaleLowerCase() === "t" && event.shiftKey && event.metaKey !== event.ctrlKey;
}

export function filterTools<T extends ToolRow>(rows: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    const text = "agents" in row
      ? [row.name, row.source, row.description, ...row.agents.map((agent) => agentNames[agent] ?? agent)]
      : [row.name, row.agent, agentNames[row.agent] ?? row.agent, row.url, row.command, row["url/command"], row.status, row.reason, row.displayName, row.needsAuth ? "인증 필요" : ""];
    return text.filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
  });
}

async function fetchTools(path: string, init?: RequestInit): Promise<ToolsState> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error((await response.text()) || `도구 정보를 불러오지 못했습니다 (${response.status})`);
  return response.json() as Promise<ToolsState>;
}

export function ToolsPanel({ workspaceId, cwd, initialState, initialTab = "mcp", request = fetchTools, onChange }: {
  workspaceId: WorkspaceId;
  cwd: string;
  initialState?: ToolsState;
  initialTab?: ToolTab;
  request?: (path: string, init?: RequestInit) => Promise<ToolsState>;
  onChange?: (state: ToolsState) => void;
}) {
  const [tab, setTab] = useState<ToolTab>(initialTab);
  const [query, setQuery] = useState("");
  const [tools, setTools] = useState<ToolsState | undefined>(initialState);
  const [loading, setLoading] = useState(!initialState);
  const [updating, setUpdating] = useState<string>();
  const [error, setError] = useState("");
  const requestGate = useRef(createRequestGate());
  const mutationLock = useRef(false);

  const load = async () => {
    const requestId = requestGate.current.begin();
    setLoading(true);
    setError("");
    try {
      const next = await request(toolsListPath(workspaceId, cwd));
      if (!requestGate.current.isCurrent(requestId)) return;
      setTools(next);
      onChange?.(next);
    }
    catch (cause) {
      if (requestGate.current.isCurrent(requestId)) setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { if (requestGate.current.isCurrent(requestId)) setLoading(false); }
  };

  useEffect(() => {
    if (!initialState) void load();
    return () => requestGate.current.invalidate();
  }, [workspaceId, cwd]);

  const mcpGroups = useMemo(() => {
    const rows = filterTools(tools?.mcp ?? [], query);
    return ["codex", "claude", "grok", ...rows.map((row) => row.agent)]
      .filter((agent, index, all) => all.indexOf(agent) === index)
      .map((agent) => [agent, rows.filter((row) => row.agent === agent)] as const)
      .filter(([, group]) => group.length);
  }, [tools?.mcp, query]);
  const skillGroups = useMemo(() => {
    const rows = filterTools(tools?.skills ?? [], query);
    return [...new Set(rows.map((row) => row.source))].map((source) => [source, rows.filter((row) => row.source === source)] as const);
  }, [tools?.skills, query]);

  const update = async (kind: "mcp" | "skill", name: string, enabled: boolean, agent?: string) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    const requestId = requestGate.current.begin();
    const key = `${kind}:${agent ?? ""}:${name}`;
    setUpdating(key); setError("");
    try {
      const next = toolUpdateRequest(workspaceId, cwd, kind, name, enabled, agent);
      const state = await request(next.path, next.init);
      if (!requestGate.current.isCurrent(requestId)) return;
      setTools(state);
      onChange?.(state);
    } catch (cause) {
      if (requestGate.current.isCurrent(requestId)) setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally {
      mutationLock.current = false;
      if (requestGate.current.isCurrent(requestId)) setUpdating(undefined);
    }
  };

  const total = tab === "mcp" ? tools?.mcp.length ?? 0 : tools?.skills.length ?? 0;
  const visible = tab === "mcp" ? mcpGroups.reduce((sum, [, rows]) => sum + rows.length, 0) : skillGroups.reduce((sum, [, rows]) => sum + rows.length, 0);
  return <section className="tools-page" aria-labelledby="tools-heading">
    <header className="tools-heading">
      <div><Wrench size={24} aria-hidden="true" /><div><h1 id="tools-heading">도구 관리</h1><p>{workspaceId === "company" ? "회사" : "개인"} 공간에서 에이전트가 사용할 MCP와 스킬을 관리합니다.</p></div></div>
      <span className="tools-count" aria-label={`전체 ${total}개`}>{total}</span>
    </header>
    <div className="glass tools-surface">
      <div className="tools-toolbar">
        <div className="tools-tabs" role="tablist" aria-label="도구 종류">
          <button role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")}><SlidersHorizontal size={16} />MCP</button>
          <button role="tab" aria-selected={tab === "skills"} onClick={() => setTab("skills")}><Wrench size={16} />스킬</button>
        </div>
        <label className="tools-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="도구 검색" placeholder="이름, 에이전트, 설명 검색" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      </div>
      {error && <div className="tools-error" role="alert"><span>{error}</span><button className="button light" onClick={() => void load()}>다시 시도</button></div>}
      {loading && <div className="tools-empty" role="status">도구 상태를 확인하는 중…</div>}
      {!loading && tools && tab === "mcp" && <div className="tools-groups" role="tabpanel">
        {mcpGroups.map(([agent, rows]) => <section className="tools-group" key={agent} aria-labelledby={`tools-${agent}`}>
          <h2 id={`tools-${agent}`}><AgentMark agent={agent} />{agentNames[agent] ?? agent}<span>{rows.length}</span></h2>
          <div className="tools-list">{rows.map((tool) => {
            const enabled = tool.nativeEnabled && tool.appEnabled && !tool.forcedOff;
            const presentation = toolStatusPresentation(tool);
            return <div className={`tool-row${tool.forcedOff ? " locked" : ""}`} key={`${tool.agent}:${tool.name}`}>
              <div className="tool-copy"><strong title={tool.name}>{tool.displayName ?? tool.name}</strong><span>{tool.url || tool.command || tool["url/command"] || "앱 설정"}</span>{tool.agent === "claude" && !tool.forcedOff && !tool.reason && <small>Claude MCP는 앱에서만 켜고 끕니다. CLI 연결 상태는 읽기 전용입니다.</small>}{tool.reason && !tool.needsAuth && <small>{tool.reason}</small>}{tool.needsAuth && tool.authHint && <small>{tool.authHint} · 안 쓰면 꺼두세요.</small>}</div>
              <span className={`tool-status ${presentation.tone}`}>{tool.forcedOff && <LockKeyhole size={13} />}{presentation.label}</span>
              {tool.needsAuth && enabled && tool.authCommand && <button className="button light" type="button" onClick={() => openTerminal({ command: tool.authCommand })}>인증하기</button>}
              <button className="tool-switch" type="button" role="switch" aria-checked={enabled} aria-label={`${tool.name} ${enabled ? "끄기" : "켜기"}`} disabled={Boolean(tool.forcedOff) || Boolean(updating)} onClick={() => void update("mcp", tool.name, !enabled, tool.agent)}><span /></button>
            </div>;
          })}</div>
        </section>)}
      </div>}
      {!loading && tools && tab === "skills" && <div className="tools-groups" role="tabpanel">
        {skillGroups.map(([source, rows], index) => <section className="tools-group" key={source} aria-labelledby={`skills-source-${index}`}>
          <h2 id={`skills-source-${index}`}><span className="source-mark">{source.slice(0, 1)}</span>{source}<span>{rows.length}</span></h2>
          <div className="tools-list">{rows.map((skill) => {
            return <div className="tool-row skill-row" key={`${source}:${skill.name}`}>
              <div className="tool-copy"><strong>{skill.name}</strong><span>{skill.description}</span><span className="tool-agents">{skill.agents.map((agent) => <span key={agent}><AgentMark agent={agent} size="small" />{agentNames[agent] ?? agent}</span>)}</span></div>
              <span className={`tool-status ${skill.enabled ? "enabled" : "disabled"}`}>{skill.enabled ? "사용 중" : "사용 안 함"}</span>
              <button className="tool-switch" type="button" role="switch" aria-checked={skill.enabled} aria-label={`${skill.name} ${skill.enabled ? "끄기" : "켜기"}`} disabled={Boolean(updating)} onClick={() => void update("skill", skill.name, !skill.enabled)}><span /></button>
            </div>;
          })}</div>
        </section>)}
      </div>}
      {!loading && tools && visible === 0 && <div className="tools-empty" role="status">{query ? "검색 결과가 없습니다." : "표시할 도구가 없습니다."}</div>}
    </div>
  </section>;
}
