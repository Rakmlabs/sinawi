import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bell, Briefcase, Check, ExternalLink, FolderOpen, Home, Keyboard, Monitor, MousePointerClick, Plug, RefreshCw, ShieldCheck, Sparkles, SquareTerminal, TriangleAlert, Wrench, X } from "lucide-react";
import type { SetupTool, PermissionId, PermissionState } from "../server/setup";
import type { WorkspaceId } from "../server/types";
import { CopyButton } from "./CopyButton";
import { openTerminal } from "./terminal-events";
import { permissionView, tauriInvoke, type PermState, loginStatus, saveProgress, SHORTCUTS, STEPS, toolsStatus, type AuthStatus, type OnboardingProgress, type StepStatus } from "./onboarding-state";
import "./onboarding.css";

export type SetupInfo = { platform: string; tools: SetupTool[]; permissions: Record<PermissionId, PermissionState> };
type Group = { id: string; name: string; workspaceId?: WorkspaceId };
type Mcp = { agent: string; name: string; displayName?: string; status: string; needsAuth?: boolean; forcedOff?: boolean; reason?: string };

const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const text = await r.text();
  let data: unknown; try { data = text ? JSON.parse(text) : undefined; } catch { throw new Error("서버 응답을 읽지 못했습니다."); }
  if (!r.ok) throw new Error((data as { error?: string })?.error || "요청을 처리하지 못했습니다.");
  return data as T;
};

function Badge({ status, children }: { status: StepStatus | "info"; children?: ReactNode }) {
  if (status === "info" && !children) return null;
  return <span className={`ob-badge ${status}`}>{status === "ok" ? <Check size={13} /> : status === "warn" ? <TriangleAlert size={13} /> : null}{children ?? (status === "ok" ? "준비됨" : status === "warn" ? "확인 필요" : "")}</span>;
}

function Command({ command, label }: { command: string; label: string }) {
  return <div className="ob-command"><code>{command}</code><CopyButton text={command} ariaLabel={`${label} 명령 복사`} showLabel /></div>;
}

export function Onboarding({ progress, onProgress, onClose, onMinimize, workspaceId, onSwitchWorkspace }: {
  progress: OnboardingProgress; onProgress: (next: OnboardingProgress) => void; onClose: (completed: boolean) => void; onMinimize: () => void;
  workspaceId: WorkspaceId; onSwitchWorkspace: (id: WorkspaceId) => void;
}) {
  const [setup, setSetup] = useState<SetupInfo>();
  const [auth, setAuth] = useState<Partial<Record<string, AuthStatus>>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newGroup, setNewGroup] = useState<{ name: string; workspaceId: WorkspaceId }>({ name: "", workspaceId: "personal" });
  const [native, setNative] = useState<Partial<Record<PermissionId, PermState>>>({});
  const [requesting, setRequesting] = useState<PermissionId>();
  const [notification, setNotification] = useState<string>(() => typeof Notification === "undefined" ? "unknown" : Notification.permission);
  const step = STEPS[progress.step];
  const set = (patch: Partial<OnboardingProgress>) => { const next = { ...progress, ...patch }; saveProgress(next); onProgress(next); };
  const go = (index: number) => set({ step: Math.max(0, Math.min(STEPS.length - 1, index)) });
  const ack = (id: string) => set({ acknowledged: progress.acknowledged.includes(id) ? progress.acknowledged.filter((v) => v !== id) : [...progress.acknowledged, id] });

  const check = useCallback(async (refreshAuth = false) => {
    setChecking(true); setError("");
    try {
      if (refreshAuth) await json("/api/settings/models/refresh", { method: "POST" }).catch(() => undefined);
      const [info, settings, groupList] = await Promise.all([
        json<SetupInfo>("/api/setup"),
        json<{ modelOptions?: Record<string, { authStatus?: AuthStatus }> }>("/api/settings").catch(() => ({ modelOptions: {} })),
        json<Group[]>("/api/groups").catch(() => []),
      ]);
      setSetup(info); setGroups(groupList);
      const invoke = tauriInvoke();
      if (invoke) setNative(await invoke("permission_status").then((v) => v as Record<PermissionId, PermState>).catch(() => ({})));
      setAuth(Object.fromEntries(Object.entries(settings.modelOptions ?? {}).map(([id, option]) => [id, (option as { authStatus?: AuthStatus } | undefined)?.authStatus])));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (mcp) return; // prefetch: MCP discovery runs each CLI and can take a few seconds
    void json<{ mcp: Mcp[] }>(`/api/tools?workspace=${workspaceId}`).then((r) => setMcp(r.mcp), () => setMcp([]));
  }, [mcp, workspaceId]);

  const tools = setup?.tools;
  const agents = tools?.filter((t) => t.agent) ?? [];
  const statusOf = (id: string): StepStatus | "info" => {
    if (id === "tools") return toolsStatus(tools);
    if (id === "login") return loginStatus(tools, auth);
    if (id === "permissions") return permissionRows.every((row) => row.state === "ok") ? "ok" : "warn";
    if (id === "workspaces") return groups.length ? "ok" : "info";
    return "info";
  };
  const openPane = async (pane: PermissionId) => {
    try { await json("/api/setup/open-settings", { method: "POST", body: JSON.stringify({ pane }) }); setNotice("시스템 설정을 열었어요. 목록에서 Agent Orchestra를 켜 주세요."); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const runLogin = (command: string) => { openTerminal({ command }); onMinimize(); };
  const createGroup = async () => {
    const name = newGroup.name.trim(); if (!name) return;
    try { await json("/api/groups", { method: "POST", body: JSON.stringify({ name, workspaceId: newGroup.workspaceId }) }); setNewGroup({ ...newGroup, name: "" }); setNotice(`‘${name}’ 프로젝트를 만들었어요.`); void check(); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  const permState = (p: PermissionId) => permissionView(native[p], p === "notifications" ? (notification === "default" ? "unknown" : notification as PermState) : setup?.permissions[p], progress.acknowledged.includes(p));
  /** Ask from the app process itself (so macOS lists the app), then open the matching settings pane. */
  const request = async (p: PermissionId) => {
    const invoke = tauriInvoke();
    setRequesting(p);
    try {
      if (invoke && p !== "files") {
        const result = await invoke("request_permission", { kind: p }).catch(() => "unknown") as PermState;
        setNative((old) => ({ ...old, [p]: result }));
        if (result === "granted") { setNotice("허용됐어요."); return; }
      } else if (p === "notifications" && typeof Notification !== "undefined") {
        setNotification(await Notification.requestPermission());
      }
      await openPane(p);
      if (p === "files") setNotice("목록 아래 + 를 눌러 응용 프로그램 › Agent Orchestra를 추가하거나, Finder에서 앱을 목록으로 끌어다 놓은 뒤 스위치를 켜 주세요.");
      else if (p !== "notifications") setNotice("목록에서 Agent Orchestra 스위치를 켠 뒤, 앱을 다시 열면 적용돼요.");
    } finally { setRequesting(undefined); }
  };
  const permissionRows: { id: PermissionId; icon: ReactNode; title: string; why: string; optional?: boolean; state: "ok" | "warn" | "manual" }[] = [
    { id: "notifications", icon: <Bell size={18} />, title: "알림", why: "작업이 끝나거나 로그인이 필요할 때 알려 드려요.", state: permState("notifications") },
    { id: "screen", icon: <Monitor size={18} />, title: "화면 기록", why: "에이전트가 화면 스크린샷을 찍어 확인할 때 필요해요.", state: permState("screen") },
    { id: "accessibility", icon: <MousePointerClick size={18} />, title: "손쉬운 사용", why: "에이전트가 다른 앱을 클릭·입력하게 할 때만 필요해요.", optional: true, state: permState("accessibility") },
    { id: "files", icon: <FolderOpen size={18} />, title: "전체 디스크 접근", why: "데스크탑·문서·다운로드 밖 폴더에서 작업할 때 매번 묻지 않게 해요.", optional: true, state: permState("files") },
  ];

  const body = () => {
    switch (step.id) {
      case "tools": return <>
        <p className="ob-lead">에이전트를 실행하려면 아래 도구가 필요해요. <strong>Claude · Codex · Grok 중 하나만</strong> 있어도 시작할 수 있어요.</p>
        <div className="ob-list">{tools ? tools.map((tool) => <div key={tool.id} className={`ob-row ${tool.installed ? "ok" : tool.agent ? "optional" : "warn"}`}>
          <div className="ob-row-head"><strong>{tool.name}</strong>{tool.agent && <small>에이전트</small>}<span className="ob-spacer" />{tool.installed ? <Badge status="ok">{tool.version ? `v${tool.version}` : "설치됨"}</Badge> : <Badge status="warn">{tool.agent ? "없음 (선택)" : "설치 필요"}</Badge>}</div>
          {!tool.installed && <><Command command={tool.install} label={tool.name} /><a className="ob-link" href={tool.docs} target="_blank" rel="noreferrer">공식 설치 안내 <ExternalLink size={12} /></a></>}
        </div>) : <p className="ob-muted">확인하는 중…</p>}</div>
        <p className="ob-muted">설치 명령은 터미널에 붙여 넣어 실행하세요. 설치 후 <b>다시 확인</b>을 누르면 바로 반영돼요.</p>
      </>;
      case "login": return <>
        <p className="ob-lead">설치한 에이전트마다 한 번씩 로그인해 주세요. 버튼을 누르면 내장 터미널에서 로그인 명령이 실행돼요.</p>
        <div className="ob-list">{agents.map((tool) => {
          const status = !tool.installed ? "none" : auth[tool.id] ?? "unknown";
          return <div key={tool.id} className={`ob-row ${status === "authenticated" ? "ok" : status === "none" ? "optional" : "warn"}`}>
            <div className="ob-row-head"><strong>{tool.name}</strong><span className="ob-spacer" />
              {status === "authenticated" ? <Badge status="ok">로그인됨</Badge> : status === "none" ? <Badge status="info">설치 안 됨</Badge> : status === "unauthenticated" ? <Badge status="warn">로그인 필요</Badge> : <Badge status="warn">확인 안 됨</Badge>}</div>
            {tool.installed && status !== "authenticated" && tool.login && <div className="ob-actions"><Command command={tool.login} label={`${tool.name} 로그인`} /><button className="ob-btn primary" onClick={() => runLogin(tool.login!)}><SquareTerminal size={15} />터미널에서 로그인</button></div>}
          </div>;
        })}</div>
        <p className="ob-muted">로그인을 마친 뒤 <b>다시 확인</b>을 누르면 상태를 새로 읽어요. API 키를 쓰는 경우에도 로그인됨으로 표시돼요.</p>
      </>;
      case "permissions": return <>
        <p className="ob-lead">macOS가 앱마다 따로 허락을 받아요. 필요한 것만 켜 두면 돼요.</p>
        {setup && setup.platform !== "darwin" && <p className="ob-notice">macOS가 아니라서 이 단계는 건너뛰어도 돼요.</p>}
        <div className="ob-list">{permissionRows.map((row) => <div key={row.id} className={`ob-row ${row.state === "ok" ? "ok" : row.optional ? "optional" : "warn"}`}>
          <div className="ob-row-head">{row.icon}<strong>{row.title}</strong>{row.optional && <small>선택</small>}<span className="ob-spacer" />
            {row.state === "ok" ? <Badge status="ok">{progress.acknowledged.includes(row.id) ? "확인함" : "허용됨"}</Badge> : row.state === "warn" ? <Badge status="warn">꺼져 있음</Badge> : <Badge status="info">직접 확인</Badge>}</div>
          <p className="ob-why">{row.why}</p>
          {row.id === "files" && row.state !== "ok" && <p className="ob-hint">전체 디스크 접근은 앱이 직접 요청할 수 없어요. 설정 화면의 <b>+</b> 버튼으로 <b>응용 프로그램 › Agent Orchestra</b>를 추가하거나 Finder에서 앱을 목록으로 끌어다 놓으세요.</p>}
          <div className="ob-actions">
            {row.state !== "ok" && <button className="ob-btn primary" disabled={requesting === row.id} onClick={() => void request(row.id)}>{row.icon}{row.id === "files" ? "설정에서 추가하기" : requesting === row.id ? "요청 중…" : "권한 요청"}</button>}
            <button className="ob-btn" onClick={() => void openPane(row.id)}><ExternalLink size={15} />시스템 설정 열기</button>
            {(row.id === "files" || !native[row.id] || native[row.id] === "unknown") && (row.state !== "ok" || progress.acknowledged.includes(row.id)) ? <label className="ob-check"><input type="checkbox" checked={progress.acknowledged.includes(row.id)} onChange={() => ack(row.id)} />켰어요</label> : null}
          </div>
        </div>)}</div>
        <p className="ob-muted"><b>권한 요청</b>을 누르면 macOS가 묻고, 시스템 설정 목록에 Agent Orchestra가 나타나요. 켠 뒤 <b>다시 확인</b>을 누르면 상태가 바뀌어요. 화면 기록은 앱을 다시 열어야 적용돼요.</p>
      </>;
      case "workspaces": return <>
        <p className="ob-lead">대화와 프로젝트는 <strong>개인</strong>과 <strong>회사</strong> 두 공간으로 나뉘어요. F1 / F2로 언제든 바꿀 수 있어요.</p>
        <div className="ob-spaces">
          {(["personal", "company"] as WorkspaceId[]).map((id) => <button key={id} className={`ob-space ${workspaceId === id ? "active" : ""}`} onClick={() => onSwitchWorkspace(id)}>
            <div className="ob-row-head">{id === "personal" ? <Home size={18} /> : <Briefcase size={18} />}<strong>{id === "personal" ? "개인" : "회사"}</strong><span className="ob-spacer" />{workspaceId === id && <Badge status="ok">사용 중</Badge>}</div>
            <p>{id === "personal" ? "모든 에이전트와 개인 MCP·이미지·영상 도구를 쓸 수 있어요." : "회사 코드 보호를 위해 개인 MCP 연결과 이미지·영상 생성이 막혀요. 회사에서 허용한 에이전트만 실행돼요."}</p>
            <small>프로젝트 {groups.filter((g) => (g.workspaceId ?? "personal") === id).length}개</small>
          </button>)}
        </div>
        <div className="ob-row"><div className="ob-row-head"><FolderOpen size={18} /><strong>프로젝트 만들기</strong><small>선택</small></div>
          <p className="ob-why">프로젝트로 대화를 묶어 두면 사이드바에서 찾기 쉬워요. 작업 폴더는 대화를 시작할 때 고를 수 있어요.</p>
          <div className="ob-actions"><input className="ob-input" placeholder="예: 블로그 리뉴얼" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void createGroup(); }} />
            <select className="ob-input small" value={newGroup.workspaceId} onChange={(e) => setNewGroup({ ...newGroup, workspaceId: e.target.value as WorkspaceId })}><option value="personal">개인</option><option value="company">회사</option></select>
            <button className="ob-btn primary" disabled={!newGroup.name.trim()} onClick={() => void createGroup()}>만들기</button></div>
        </div>
      </>;
      case "connections": return <>
        <p className="ob-lead">MCP를 연결하면 에이전트가 메일·문서·디자인 도구 같은 외부 서비스를 쓸 수 있어요. 지금 안 해도 돼요.</p>
        <div className="ob-list">{mcp === undefined ? <p className="ob-muted">각 CLI의 MCP 목록을 불러오는 중… (몇 초 걸려요)</p> : mcp.length === 0 ? <div className="ob-row optional"><div className="ob-row-head"><Plug size={18} /><strong>연결된 MCP가 아직 없어요</strong></div><p className="ob-why">각 CLI에 MCP를 추가하면 여기와 도구 관리에 자동으로 나타나요.</p></div>
          : mcp.slice(0, 8).map((tool) => <div key={`${tool.agent}:${tool.name}`} className={`ob-row ${tool.needsAuth ? "warn" : "ok"}`}><div className="ob-row-head"><Plug size={16} /><strong>{tool.displayName ?? tool.name}</strong><small>{tool.agent}</small><span className="ob-spacer" />{tool.forcedOff ? <Badge status="info">회사에서 차단</Badge> : tool.needsAuth ? <Badge status="warn">인증 필요</Badge> : <Badge status="ok">{tool.status === "connected" ? "연결됨" : "사용 가능"}</Badge>}</div></div>)}
          {mcp && mcp.length > 8 && <p className="ob-muted">외 {mcp.length - 8}개</p>}</div>
        <button className="ob-btn" onClick={() => { window.dispatchEvent(new CustomEvent("orchestra:open-tools")); onMinimize(); }}><Wrench size={15} />도구 관리 열기 (⌘⇧T)</button>
      </>;
      case "done": return <>
        <div className="ob-done"><Sparkles size={28} /><h3>준비 끝!</h3><p>{agents.filter((t) => t.installed).map((t) => t.name).join(" · ") || "에이전트"}로 바로 시작할 수 있어요. 자주 쓰는 단축키예요.</p></div>
        <div className="ob-shortcuts">{SHORTCUTS.map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div>
        <p className="ob-muted">설정 도우미는 도움말(?) 화면이나 메뉴 막대의 <b>Help › 설정 도우미 다시 열기</b>에서 다시 열 수 있어요.</p>
      </>;
    }
  };

  return <div className="ob-backdrop" role="presentation">
    <section className="ob-dialog" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <aside className="ob-steps">
        <div className="ob-brand"><ShieldCheck size={20} /><div><strong>설정 도우미</strong><small>Agent Orchestra 시작하기</small></div></div>
        <ol>{STEPS.map((item, index) => { const s = statusOf(item.id); return <li key={item.id}><button className={`${index === progress.step ? "current" : ""}`} onClick={() => go(index)}>
          <span className={`ob-dot ${s}`}>{s === "ok" ? <Check size={12} /> : s === "warn" ? "!" : index + 1}</span>{item.title}</button></li>; })}</ol>
        <button className="ob-skip" onClick={() => { set({ skipped: true }); onClose(false); }}>나중에 할게요</button>
      </aside>
      <div className="ob-main">
        <header><div><small>{progress.step + 1} / {STEPS.length}</small><h2 id="ob-title">{step.title}</h2></div><span className="ob-spacer" />
          {step.id !== "done" && <Badge status={statusOf(step.id)} />}
          <button className="ob-icon" aria-label="다시 확인" title="다시 확인" disabled={checking} onClick={() => void check(step.id === "login")}><RefreshCw size={16} className={checking ? "spin" : ""} /></button>
          <button className="ob-icon" aria-label="설정 도우미 닫기" title="닫기 (나중에 다시 열 수 있어요)" onClick={() => { set({ skipped: !progress.completed }); onClose(false); }}><X size={17} /></button></header>
        {error && <p className="ob-notice warn">{error}</p>}
        {notice && <p className="ob-notice" role="status">{notice}</p>}
        <div className="ob-body">{body()}</div>
        <footer>
          <button className="ob-btn" disabled={progress.step === 0} onClick={() => { setNotice(""); go(progress.step - 1); }}><ArrowLeft size={15} />이전</button>
          <button className="ob-btn" disabled={checking} onClick={() => void check(step.id === "login")}><RefreshCw size={15} />다시 확인</button>
          <span className="ob-spacer" />
          {step.id === "done" ? <button className="ob-btn primary" onClick={() => { set({ completed: true, skipped: false }); onClose(true); }}><Keyboard size={15} />시작하기</button>
            : <button className="ob-btn primary" onClick={() => { setNotice(""); go(progress.step + 1); }}>다음<ArrowRight size={15} /></button>}
        </footer>
      </div>
    </section>
  </div>;
}
