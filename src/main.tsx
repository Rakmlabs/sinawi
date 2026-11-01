import { MarkdownSessionContext } from "./markdown-images";
import { isNetworkFailure, teamAvailabilityWarning } from "./team";
import { normalizeWorkerConfigs } from "../server/workers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Folder,
  Globe,
  MousePointerClick,
  ImageIcon,
  Layers,
  LoaderCircle,
  MessageSquare,
  Plus,
  Radio,
  Search,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Users,
  WandSparkles,
  X,
  PanelRightClose,
  PanelRightOpen,
  FileText,
  ChevronRight,
  Paperclip,
} from "lucide-react";
import "./fonts.css";
import "./style.css";
import "./viewer.css";
import { WorkspaceAgentPolicy, ModelChoice, RecommendationCard, RoutingSettingsPage } from "./RoutingControls";
import type { RoutingSettings, RoutingRecommendation } from "../server/routing";
import { fileToken, handlesCompletionKey, historyEntries, historyStep, slashToken, matchingSkills, numberedOptions, recentPaths, isUsageCommand, composerAction, composerLocked } from "./composer";
import { allowedAgentsForWorkspace } from "../server/workspace-policy";
import { UsagePanel } from "./UsagePanel";
import { submitSession } from "./submit";
import { GlassSelect } from "./GlassSelect";
import { FolderPicker } from "./FolderPicker";
import { ComposerPopover } from "./ComposerPopover";
import { WorkerThread } from "./WorkerThread";
import { workerLogRows, workerLogSummary } from "./worker-log";
import { ErrorBoundary } from "./ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { automaticTeamDefaults, createWorkspaceSaver, inWorkspace, workspaceShortcut, workspaceTeamDefaults } from "./workspaces";
import { readPreference, writePreference, savedMode, savedBoolean, savedAutoSwitch } from "./preferences";
import "./polish.css";
import "./chat-layout.css";
import "./sidebar.css";
import "./team-chat.css";
import { AgentMark } from "./AgentMark";
import "./agent-mark.css";
import "./readability.css";
import { TeamBar } from "./TeamBar";
import { TerminalPanel } from "./TerminalPanel";
import { NotificationsCenter } from "./NotificationsCenter";
import { toggleTerminal, terminalOwnsKeyboardEvent, TERMINAL_AUTH_REFRESH_EVENT, TERMINAL_NOTICE_EVENT, type TerminalNotice } from "./terminal-events";
import "./terminal.css";
import "./browser.css";
import { BrowserDesktop, type DesktopRequest } from "./BrowserDesktop";
import type { DesktopMode } from "./desktop-windows";
import { holdCommand } from "./browser-agent";
import { browserRegistry } from "./browser-registry";
import { chatShortcut, globalBrowserShortcut } from "./browser-shortcuts";
import { blockHistoryButtons, isStrandedShell, returnToAppServer } from "./app-origin";
import { Onboarding } from "./Onboarding";
import { loadProgress, ONBOARDING_OPEN_EVENT, readyAgents, shouldAutoOpen, type AuthStatus } from "./onboarding-state";
import type { SetupTool } from "../server/setup";
import { afterEdgeClick, afterRailToggle, railCollapsed } from "./sidebar-rail";
import { classifyLiveMessage } from "../server/live-turn";
import { browserOwnsFocus } from "./browser-shortcuts";
import { promptWithAttachments, type ComposerAttachment } from "./preview-attachments";
import "./notifications.css";
import { isTauri, WindowHeader } from "./WindowHeader";
import "./window-header.css";
import { canPromoteLive, canUndoAutoHandoff, conversationText, delegationTasks, delegationWorkers, liveBadgeLabel, mainConversation, mergeSession } from "./conversation";
import { Markdown } from "./Markdown";
import { isNearChatBottom, streamingAssistantMessageId } from "./chat-scroll";
import { quotaReturnCandidate } from "./quota-fallback";
import { QuotaProvider, RemainingChip, useQuotas } from "./QuotaContext";
import { CopyButton } from "./CopyButton";
import { MessageFold, UserMessageBody, ViewerContext } from "./media-ui";
import { FileViewer } from "./FileViewer";
import { kindFromName } from "../server/media-kinds";
import { formatBytes, kindLabel, parseAttachmentMessage, uploadFraction, uploadRejection, type MediaRef } from "./viewer-model";
import { ToolsPanel, toolsShortcut } from "./ToolsPanel";
import "./tools.css";
import "./sidebar-menu.css";
import type {
  WorkspaceId,
  WorkspaceDefaults,
  WorkspaceState,
  AgentId,
  AgentSelection,
  Group,
  Session,
  SessionStatus,
  EventType,
  SkillInfo as Skill,
  Bot as Preset,
} from "../server/types";
type Bootstrap = {
  agents: {
    id: string;
    name: string;
    available: boolean;
    detail: string;
  }[];
  skills: Skill[];
  bots: Preset[];
  groups: Group[];
  defaultCwd: string;
  homeCwd?: string;
};
const names: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok Build",
  user: "나",
  system: "시스템",
};
const statusLabels: Record<SessionStatus, string> = {
  running: "진행 중",
  done: "완료",
  error: "오류",
  stopped: "중지됨",
};
const eventLabels: Record<EventType, string> = {
  message: "메시지",
  tool: "도구 사용",
  command: "명령 실행",
  edit: "파일 수정",
  status: "상태",
  error: "오류",
  warning: "경고",
  delegation: "작업 위임",
  handoff: "오케스트라 변경",
};
async function workspaceApi<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method: method ?? (body ? "POST" : "GET"),
    keepalive: path === "/workspaces",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = r.status === 204 ? "" : await r.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { throw new Error("앱 서버 응답을 읽지 못했습니다. 다시 시도하면 서버에 다시 연결합니다."); }
  if (!r.ok) throw new Error(data?.error || "요청을 처리하지 못했습니다.");
  return data;
}
const api = workspaceApi;

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceState>();
  const [workspaceError, setWorkspaceError] = useState("");
  const state = useRef<WorkspaceState | undefined>(undefined);
  const [saveWorkspaces] = useState(() => createWorkspaceSaver((body) => api("/workspaces", body, "PATCH")));
  const persist = useCallback((next: WorkspaceState) => {
    void saveWorkspaces(next).then(() => setWorkspaceError(""), (error) => setWorkspaceError((error as Error).message));
  }, [saveWorkspaces]);
  const loadWorkspaces = useCallback(async () => {
    try {
      const next = await api<WorkspaceState>("/workspaces");
      // Retain the previous global mode on the first migration only.
      if (!next.defaults.personal.mode) next.defaults.personal.mode = savedMode(readPreference("mode"));
      if (next.defaults.personal.autoSwitch === undefined) next.defaults.personal.autoSwitch = savedAutoSwitch(readPreference("autoSwitch"));
      state.current = next;
      setWorkspaces(next);
      setWorkspaceError("");
    } catch (error) { setWorkspaceError((error as Error).message); }
  }, []);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => {
    const flush = () => {
      const current = state.current;
      if (current) void saveWorkspaces(current, true).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [saveWorkspaces]);
  const updateDefaults = useCallback((workspaceId: WorkspaceId, defaults: WorkspaceDefaults) => {
    if (!state.current) return;
    state.current = { ...state.current, defaults: { ...state.current.defaults, [workspaceId]: defaults } };
    persist(state.current);
  }, [persist]);
  const switchWorkspace = useCallback((workspaceId: WorkspaceId) => {
    const current = state.current;
    if (!current || current.currentWorkspaceId === workspaceId) return;
    const next = { ...current, currentWorkspaceId: workspaceId };
    persist(next);
    state.current = next;
    setWorkspaces(next);
  }, [persist]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event)) return;
      const next = workspaceShortcut(event);
      if (!next) return;
      event.preventDefault();
      switchWorkspace(next);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [switchWorkspace]);
  // 설정 도우미: first launch, or when no agent CLI is ready; reopen from Help.
  const [onboarding, setOnboarding] = useState(loadProgress);
  const [onboardingView, setOnboardingView] = useState<"open" | "min" | "closed">("closed");
  useEffect(() => {
    let cancelled = false;
    const dismissed = sessionStorage.getItem("orchestra.onboarding.dismissed") === "1";
    if (shouldAutoOpen(loadProgress(), undefined, dismissed)) { setOnboardingView("open"); return; }
    void Promise.all([
      fetch("/api/setup").then((r) => r.json() as Promise<{ tools: SetupTool[] }>),
      fetch("/api/settings").then((r) => r.json() as Promise<{ modelOptions?: Record<string, { authStatus?: AuthStatus }> }>).catch(() => ({ modelOptions: {} })),
    ]).then(([setup, settings]) => {
      const auth = Object.fromEntries(Object.entries(settings.modelOptions ?? {}).map(([id, o]) => [id, (o as { authStatus?: AuthStatus } | undefined)?.authStatus]));
      if (!cancelled && shouldAutoOpen(loadProgress(), readyAgents(setup.tools, auth), dismissed)) setOnboardingView("open");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const open = () => setOnboardingView("open");
    window.addEventListener(ONBOARDING_OPEN_EVENT, open);
    (window as unknown as { __orchestraOpenOnboarding?: () => void }).__orchestraOpenOnboarding = open;
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, open);
  }, []);
  return <>
    {onboardingView === "open" && workspaces && <Onboarding progress={onboarding} onProgress={setOnboarding} workspaceId={workspaces.currentWorkspaceId} onSwitchWorkspace={switchWorkspace}
      onMinimize={() => setOnboardingView("min")} onClose={() => { sessionStorage.setItem("orchestra.onboarding.dismissed", "1"); setOnboardingView("closed"); }} />}
    {onboardingView === "min" && <button className="ob-resume" onClick={() => setOnboardingView("open")}>설정 도우미로 돌아가기</button>}
    {workspaceError && <div className="error-banner workspace-error" role="alert">{workspaceError}<button onClick={() => {
      if (isStrandedShell(location.href)) returnToAppServer();
      else if (!state.current) void loadWorkspaces();
      else {
        const current = state.current;
        persist(current);
      }
    }}>다시 시도</button></div>}
    {workspaces ? <WorkspaceApp key={workspaces.currentWorkspaceId} workspaceId={workspaces.currentWorkspaceId} defaults={workspaces.defaults[workspaces.currentWorkspaceId]} onDefaultsChange={updateDefaults} onSwitchWorkspace={() => switchWorkspace(workspaces.currentWorkspaceId === "personal" ? "company" : "personal")} /> : !workspaceError && <div role="status">작업 공간을 불러오는 중…</div>}
  </>;
}

function WorkspaceApp({ workspaceId, defaults, onDefaultsChange, onSwitchWorkspace }: {
  workspaceId: WorkspaceId; defaults: WorkspaceDefaults;
  onDefaultsChange: (id: WorkspaceId, defaults: WorkspaceDefaults) => void; onSwitchWorkspace: () => void;
}) {
  const api = <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
    const verb = method ?? (body ? "POST" : "GET");
    const payload = verb === "POST" && body && typeof body === "object" ? { ...body, workspaceId } : body;
    return workspaceApi<T>(path, payload, method);
  };
  const [boot, setBoot] = useState<Bootstrap>({
    agents: [],
    skills: [],
    bots: [],
    groups: [],
    defaultCwd: "",
  });
  const [allSessions, setSessions] = useState<Session[]>([]);
  const sessions = inWorkspace(allSessions, workspaceId);
  const groups = inWorkspace(boot.groups, workspaceId);
  const otherRunning = allSessions.filter((session) => session.workspaceId !== workspaceId && session.status === "running").length;
  const [workerSelection, setWorkerSelection] = useState<{ sessionId: string; taskId: string }>();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState("workspace");
  const [terminalHeight, setTerminalHeight] = useState(0);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event)) return;
      if (!toolsShortcut(event)) return;
      event.preventDefault();
      setTab("tools");
    };
    const openTools = () => setTab("tools");
    window.addEventListener("orchestra:open-tools", openTools);
    window.addEventListener("keydown", handle);
    return () => { window.removeEventListener("keydown", handle); window.removeEventListener("orchestra:open-tools", openTools); };
  }, []);
  const initialTeam = workspaceTeamDefaults(workspaceId, defaults);
  const [allowedAgents, setAllowedAgents] = useState<AgentId[]>(() => allowedAgentsForWorkspace(workspaceId, defaults.allowedAgents));
  const [agent, setAgent] = useState<AgentId>(initialTeam.agent);
  const [workers, setWorkers] = useState<AgentId[]>(initialTeam.workers);
  const [cwd, setCwd] = useState(defaults.cwd ?? "");
  const [model, setModel] = useState(initialTeam.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(initialTeam.reasoningEffort ?? "");
  const [workerConfigs, setWorkerConfigs] = useState<AgentSelection[]>(() => normalizeWorkerConfigs(initialTeam.workers, initialTeam.workerConfigs));
  const [mode, setMode] = useState<"auto" | "manual">(() => defaults.mode ?? "auto");
  const [autoSwitch, setAutoSwitch] = useState(() => defaults.autoSwitch ?? true);
  const [quotaFallback, setQuotaFallback] = useState(defaults.quotaFallback ?? true);
  const [quotaThreshold, setQuotaThreshold] = useState(defaults.quotaThreshold ?? 3);
  const [fallbackOrder, setFallbackOrder] = useState(defaults.fallbackOrder ?? {});
  const { providers: quotaProviders } = useQuotas();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => savedBoolean(readPreference("sidebarCollapsed")));
  useEffect(() => {
    onDefaultsChange(workspaceId, { cwd, mode, agent, workers, model, reasoningEffort, workerConfigs, autoSwitch, allowedAgents, quotaFallback, quotaThreshold, fallbackOrder });
  }, [workspaceId, cwd, mode, agent, workers, model, reasoningEffort, workerConfigs, autoSwitch, allowedAgents, quotaFallback, quotaThreshold, fallbackOrder, onDefaultsChange]);
  useEffect(() => { writePreference("sidebarCollapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  const [routingSettings, setRoutingSettings] = useState<RoutingSettings>();
  const [recommendation, setRecommendation] = useState<{ key: string; value: RoutingRecommendation }>();
  const [editingRecommendation, setEditingRecommendation] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [groupId, setGroupId] = useState("");
  useEffect(() => {
    if (groupId && !groups.some((group) => group.id === groupId)) setGroupId("");
  }, [groupId, boot.groups, workspaceId]);
  const [messageSkills, setMessageSkills] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [viewer, setViewer] = useState<{ items: MediaRef[]; index: number } | null>(null);
  const openViewer = useCallback((items: MediaRef[], index: number) => setViewer({ items, index }), []);
  const viewerApi = useMemo(() => ({ open: openViewer }), [openViewer]);
  const uploads = useRef(new Map<string, XMLHttpRequest>());
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setViewer(null); }, [selected]);
  const [desktopRequest, setDesktopRequest] = useState<DesktopRequest>({ n: 0 });
  const [desktopMode, setDesktopMode] = useState<DesktopMode>("none");
  const focusMode = desktopMode !== "none";
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const railHidden = railCollapsed(sidebarCollapsed, focusMode, sidebarPinned);
  const railHiddenRef = useRef(railHidden);
  railHiddenRef.current = railHidden;
  const expandSidebar = useCallback(() => {
    const next = afterEdgeClick();
    setSidebarCollapsed(next.sidebarCollapsed);
    setSidebarPinned(next.pinnedOpen);
  }, []);
  const toggleSidebar = useCallback(() => {
    const next = afterRailToggle(railHiddenRef.current);
    setSidebarCollapsed(next.sidebarCollapsed);
    setSidebarPinned(next.pinnedOpen);
  }, []);
  const [chatCollapsed, setChatCollapsed] = useState(() => localStorage.getItem("orchestra.chat.collapsed") === "1");
  useEffect(() => { localStorage.setItem("orchestra.chat.collapsed", chatCollapsed ? "1" : "0"); }, [chatCollapsed]);
  const [chatWidgetOpen, setChatWidgetOpen] = useState(() => localStorage.getItem("orchestra.chat.widget") === "1");
  useEffect(() => { localStorage.setItem("orchestra.chat.widget", chatWidgetOpen ? "1" : "0"); }, [chatWidgetOpen]);
  const showBrowser = useCallback((toggle: boolean) => { setDesktopRequest((old) => ({ n: old.n + 1, toggle })); }, []);
  // Chat fold: in browser focus (maximized) the chat is a floating widget; otherwise the pane folds to a rail.
  const toggleChat = useCallback(() => { if (desktopMode === "max") setChatWidgetOpen((v) => !v); else setChatCollapsed((v) => !v); }, [desktopMode]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (!event.repeat && chatShortcut(event)) { event.preventDefault(); toggleChat(); } };
    const onEvent = () => toggleChat();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("orchestra:toggle-chat", onEvent);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("orchestra:toggle-chat", onEvent); };
  }, [toggleChat]);
  // Commands that arrive before any browser window exists: park them and open a window.
  // The new panel drains the command from its layout effect. A timer retry never fires
  // while the webview is backgrounded (WKWebView suspends timers and animation frames).
  useEffect(() => {
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<Parameters<typeof holdCommand>[0]>).detail;
      if (!detail?.id || browserRegistry.count() > 0) return;
      holdCommand(detail);
      showBrowser(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || browserRegistry.count() > 0) return;
      if (globalBrowserShortcut(event)?.type === "toggle-panel") { event.preventDefault(); showBrowser(false); }
    };
    window.addEventListener("orchestra:browser-command", onCommand);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => { window.removeEventListener("orchestra:browser-command", onCommand); window.removeEventListener("keydown", onKey, { capture: true }); };
  }, [showBrowser]);
  const addAttachments = useCallback((items: ComposerAttachment[]) => {
    setAttachments((old) => [...old, ...items].slice(-20));
    requestAnimationFrame(() => composerInput.current?.focus());
  }, []);
  const patchAttachment = useCallback((id: string, patch: Partial<ComposerAttachment>) => {
    setAttachments((old) => old.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);
  /** Pasted or dropped files: images preview immediately, then each file uploads with progress. */
  const attachFiles = (input: File[]) => {
    const files = input.slice(0, 12);
    const rejected = files.map((file) => uploadRejection(file)).find(Boolean);
    const accepted = files.filter((file) => !uploadRejection(file));
    if (rejected) setChatError(rejected);
    if (!accepted.length) return;
    const pending = accepted.map((file) => {
      const image = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
      return {
        id: Math.random().toString(36).slice(2, 10),
        kind: image ? "image" as const : "file" as const,
        label: file.name && file.name !== "image.png" ? file.name : image ? "이미지" : "파일",
        preview: image ? URL.createObjectURL(file) : undefined,
        size: file.size,
        progress: 0,
      };
    });
    setAttachments((old) => [...old, ...pending].slice(-20));
    for (const [index, file] of accepted.entries()) {
      const id = pending[index].id;
      const xhr = new XMLHttpRequest();
      uploads.current.set(id, xhr);
      xhr.open("POST", "/api/preview/assets/raw");
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name || pending[index].label));
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) patchAttachment(id, { progress: uploadFraction(event.loaded, event.total) }); };
      xhr.onload = () => {
        uploads.current.delete(id);
        let data: { path?: string; error?: string } = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* keep */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.path) patchAttachment(id, { screenshotPath: data.path, progress: undefined, error: undefined });
        else patchAttachment(id, { progress: undefined, error: data.error || "첨부 저장 실패" });
      };
      xhr.onerror = () => { uploads.current.delete(id); patchAttachment(id, { progress: undefined, error: "첨부 저장 실패" }); };
      xhr.onabort = () => { uploads.current.delete(id); setAttachments((old) => old.filter((item) => item.id !== id)); };
      xhr.send(file);
    }
  };
  const pasteImage = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const fromItems = files.length ? [] : Array.from(event.clipboardData?.items ?? []).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    const images = (files.length ? files : fromItems).filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!images.length) return;
    event.preventDefault();
    attachFiles(images);
  };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // A file dropped outside the composer must not navigate the app window to that file.
    const block = (event: DragEvent) => { if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => { window.removeEventListener("dragover", block); window.removeEventListener("drop", block); };
  }, []);
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } },
    onDragOver: (event: React.DragEvent) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: React.DragEvent) => {
      const files = Array.from(event.dataTransfer.files ?? []);
      setDragging(false);
      if (!files.length) return;
      event.preventDefault();
      attachFiles(files);
    },
  };
  const [slash, setSlash] = useState<ReturnType<typeof slashToken>>();
  const [skillIndex, setSkillIndex] = useState(0);
  const [fileCompletion, setFileCompletion] = useState<ReturnType<typeof fileToken>>();
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const lastEscape = useRef(0);
  const filteredSkills = slash ? matchingSkills(boot.skills, slash.query).filter((skill) => !messageSkills.includes(skill.id)) : [];
  const highlightedSkill = Math.min(skillIndex, Math.max(0, filteredSkills.length - 1));
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState<string | undefined>(() => isUsageCommand(window.location.pathname) ? "usage" : undefined);
  const [skillReturn, setSkillReturn] = useState<string>();
  const sending = useRef(false);
  const liveQueue = useRef(Promise.resolve());
  const livePending = useRef(0);
  const [liveNote, setLiveNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [routing, setRouting] = useState(false);
  const [chatError, setChatError] = useState("");
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(Date.now());
  const [botName, setBotName] = useState("");
  const [botA, setBotA] = useState("");
  const [botB, setBotB] = useState("");
  const [turns, setTurns] = useState(4);
  const [activityOpen, setActivityOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const chatBody = useRef<HTMLDivElement>(null);
  const followsChatBottom = useRef(true);
  const [showChatBottom, setShowChatBottom] = useState(false);
  const active = sessions.find((s) => s.id === selected);
  useEffect(() => {
    if (selected && allSessions.some((session) => session.id === selected && session.workspaceId !== workspaceId)) {
      setSelected(undefined); setWorkerSelection(undefined); setGroupId(""); setPrompt(""); setRecommendation(undefined);
    }
  }, [allSessions, selected, workspaceId]);
  const latestHandoffId = active ? [...active.events].reverse().find((event) => event.type === "handoff")?.id : undefined;
  useEffect(() => { setActivityOpen(false); }, [active?.id]);
  const shownCwd = active?.cwd ?? cwd;
  useEffect(() => {
    if (!shownCwd) return;
    let cancelled = false;
    void api<Skill[]>(`/skills?cwd=${encodeURIComponent(shownCwd)}&workspace=${encodeURIComponent(workspaceId)}`).then((next) => {
      if (!cancelled) setBoot((old) => ({ ...old, skills: next }));
    }).catch((error) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [shownCwd]);
  const routingKey = JSON.stringify({ allowedAgents, prompt, cwd, skills, messageSkills, mode, routingSettings, systemPrompt, groupId });
  const pendingRecommendation = recommendation?.key === routingKey ? recommendation.value : undefined;
  const availableAgents = boot.agents.filter((agent) => agent.available && allowedAgents.includes(agent.id as AgentId)).map((agent) => agent.id as AgentId);
  const unavailableSelections = !active && boot.agents.length ? (mode === "manual" ? [agent, ...workers] : pendingRecommendation ? [pendingRecommendation.planner.agent, pendingRecommendation.orchestrator.agent, ...pendingRecommendation.workers.map((worker) => worker.agent)] : []).filter((id) => !availableAgents.includes(id)) : [];
  const unavailableWarning = teamAvailabilityWarning(allowedAgents, unavailableSelections);
  const sessionRunning = active?.status === "running";
  const canSendBase = Boolean(
    new Set([...skills, ...messageSkills]).size <= 20 &&
    (sessionRunning || !busy) &&
    allowedAgents.length >= 1 &&
    !(mode === "manual" && unavailableWarning) &&
    connected &&
    (active || mode === "auto" || workers.length),
  );
  const attachmentsReady = attachments.every((item) => item.progress == null && !item.error);
  const canSend = Boolean((prompt.trim() || attachments.some((item) => item.kind === "element" || item.screenshotPath)) && canSendBase && attachmentsReady);
  useEffect(() => {
    setMessageSkills([]);
    setSlash(undefined);
    setFileCompletion(undefined);
    historyIndex.current = -1;
  }, [selected]);
  useEffect(() => {
    if (slash) document.getElementById(`slash-skill-${highlightedSkill}`)?.scrollIntoView({ block: "nearest" });
  }, [slash?.query, highlightedSkill]);
  useEffect(() => {
    if (!fileCompletion || !shownCwd) { setFileSuggestions([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api<{ files: string[] }>(`/files?cwd=${encodeURIComponent(shownCwd)}&q=${encodeURIComponent(fileCompletion.query)}`)
        .then((result) => { if (!cancelled) setFileSuggestions(result.files); })
        .catch(() => { if (!cancelled) setFileSuggestions([]); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileCompletion?.query, shownCwd]);
  const running = sessions.filter((s) => s.status === "running").length;
  const load = async () => {
    try {
      const [bootstrapResult, sessionsResult, settingsResult] = await Promise.allSettled([
        api<Bootstrap>("/bootstrap"),
        api<Session[]>("/sessions"),
        api<RoutingSettings>("/settings"),
      ]);
      if (bootstrapResult.status === "fulfilled") {
        setBoot(bootstrapResult.value);
        setCwd((c) => c || bootstrapResult.value.defaultCwd);
      }
      if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value);
      if (settingsResult.status === "fulfilled") setRoutingSettings(settingsResult.value);
      else setRoutingSettings(undefined);
      const failure = [bootstrapResult, sessionsResult, settingsResult].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refreshModels = useCallback(async (reason?: string) => {
    try { setRoutingSettings(await workspaceApi<RoutingSettings>("/settings/models/refresh", { reason })); } catch {}
  }, []);
  useEffect(() => {
    let lastFocus = 0;
    const focus = () => {
      if (Date.now() - lastFocus < 60_000) return;
      lastFocus = Date.now();
      void refreshModels("focus");
    };
    const login = () => { void refreshModels("login"); };
    const notice = (event: Event) => {
      const detail = (event as CustomEvent<TerminalNotice>).detail;
      if (!detail) return;
      void workspaceApi("/notifications", { ...detail, workspaceId }).catch(() => undefined);
    };
    window.addEventListener("focus", focus);
    window.addEventListener(TERMINAL_AUTH_REFRESH_EVENT, login);
    window.addEventListener(TERMINAL_NOTICE_EVENT, notice);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener(TERMINAL_AUTH_REFRESH_EVENT, login);
      window.removeEventListener(TERMINAL_NOTICE_EVENT, notice);
    };
  }, [workspaceId, refreshModels]);
  useEffect(() => {
    if (!error) return;
    // A dropped fetch (server restart, sleep, aborted probe) is not a request error: log it, don't notify.
    if (isNetworkFailure(error)) { console.warn("[orchestra] network request failed:", error); setError(""); return; }
    void workspaceApi("/notifications", { workspaceId, type: "error", title: "요청 처리 오류", body: error, key: `request:${error.slice(0, 100)}` }).catch(() => undefined);
    setError("");
  }, [error, workspaceId]);
  useEffect(() => {
    void load();
    let ws: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    function connect() {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "notifications") window.dispatchEvent(new Event("orchestra:notifications"));
        if (message.type === "browser-command") window.dispatchEvent(new CustomEvent("orchestra:browser-command", { detail: message }));
        if (message.type === "sessions") setSessions(message.sessions);
        if (message.type === "groups") setBoot((old) => ({ ...old, groups: message.groups }));
        if (message.type === "session_deleted") {
          setSessions((old) => old.filter((session) => session.id !== message.sessionId));
          setSelected((current) => current === message.sessionId ? undefined : current);
        }
        if (message.type === "session")
          setSessions((old) => {
            const previous = old.find((s) => s.id === message.session.id);
            const incoming = message.session as Session;
            const events =
              message.incremental && previous
                ? [
                    ...new Map(
                      [...previous.events, ...incoming.events].map((e) => [
                        e.id,
                        e,
                      ]),
                    ).values(),
                  ].slice(-2000)
                : incoming.events;
            return [
              { ...incoming, events },
              ...old.filter((s) => s.id !== incoming.id),
            ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed)
          timer = setTimeout(() => {
            void load();
            connect();
          }, 2000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const scrollToChatBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const body = chatBody.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior });
    else bottom.current?.scrollIntoView({ behavior, block: "nearest" });
    followsChatBottom.current = true;
    setShowChatBottom(false);
  }, []);
  useEffect(() => {
    followsChatBottom.current = true;
    setShowChatBottom(false);
    const frame = requestAnimationFrame(() => scrollToChatBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [selected, workerSelection?.taskId, scrollToChatBottom]);
  useEffect(() => {
    if (followsChatBottom.current) scrollToChatBottom("auto");
  }, [active?.events.at(-1)?.id, active?.events.at(-1)?.text, pendingRecommendation, editingRecommendation, scrollToChatBottom]);
  // Stick to bottom only while the user is already there; late layout growth (images, code) keeps the pin.
  useEffect(() => {
    const body = chatBody.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (followsChatBottom.current) body.scrollTop = body.scrollHeight; });
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [selected, workerSelection?.taskId, active?.events.length]);
  const safe = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const adoptSession = (updated: Session) => {
    setSessions((old) => {
      const previous = old.find((item) => item.id === updated.id);
      const merged = previous ? mergeSession(previous, updated) : updated;
      if (!previous) return [merged, ...old];
      return old.map((item) => item.id === merged.id ? merged : item);
    });
  };
  const storeSentPrompt = (visibleMessage: string) => {
    try {
      const history = JSON.parse(localStorage.getItem(`orchestra.${workspaceId}.recentFolders`) ?? "[]");
      localStorage.setItem(`orchestra.${workspaceId}.recentFolders`, JSON.stringify(recentPaths([active?.cwd ?? cwd, ...recentPaths(history)])));
    } catch { /* Folder history is optional. */ }
    try {
      const stored = JSON.parse(localStorage.getItem("orchestra.promptHistory") ?? "[]");
      const globalHistory = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
      if (visibleMessage.trim()) localStorage.setItem("orchestra.promptHistory", JSON.stringify(historyEntries([visibleMessage], globalHistory).slice(0, 100)));
    } catch { /* Prompt history is optional. */ }
  };
  const clearComposer = (sentAttachments: ComposerAttachment[]) => {
    setPrompt("");
    historyIndex.current = -1;
    historyDraft.current = "";
    setRecommendation(undefined);
    setMessageSkills([]);
    setAttachments((old) => old.filter((item) => !sentAttachments.includes(item)));
    setSlash(undefined);
    setFileCompletion(undefined);
  };
  const stopActive = () => {
    if (!active || active.status !== "running") return;
    void safe(async () => { await api(`/sessions/${active.id}/stop`, {}); });
  };
  const sendWhileRunning = (visibleMessage: string) => {
    if (!active || active.status !== "running") return Promise.resolve();
    if ((!visibleMessage.trim() && !attachments.length) || !attachmentsReady) return Promise.resolve();
    if (new Set([...skills, ...messageSkills]).size > 20 || !connected) return Promise.resolve();
    const intent = classifyLiveMessage(visibleMessage).intent;
    if (intent === "stop") {
      setPrompt("");
      setSlash(undefined);
      setFileCompletion(undefined);
      historyIndex.current = -1;
      historyDraft.current = "";
      stopActive();
      return Promise.resolve();
    }
    const sessionId = active.id;
    const sentAttachments = attachments;
    const sentSkills = messageSkills;
    const composed = promptWithAttachments(visibleMessage, sentAttachments);
    clearComposer(sentAttachments);
    setChatError("");
    livePending.current += 1;
    setLiveNote(intent === "directive" ? "다음 턴에 넣는 중…" : "상태를 확인하고 있습니다…");
    const run = () => api<Session>(`/sessions/${sessionId}/live`, { prompt: composed }).then((updated) => {
      adoptSession(updated);
      storeSentPrompt(visibleMessage);
    }).catch((error) => {
      setChatError(error instanceof Error ? error.message : String(error));
      setPrompt((current) => current.trim() ? current : visibleMessage);
      setMessageSkills((current) => current.length ? current : sentSkills);
      setAttachments((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...sentAttachments.filter((item) => !ids.has(item.id)), ...current];
      });
    }).finally(() => {
      livePending.current = Math.max(0, livePending.current - 1);
      if (livePending.current === 0) setLiveNote("");
    });
    const job = liveQueue.current.then(run, run);
    liveQueue.current = job.then(() => undefined, () => undefined);
    return job;
  };
  const promoteLiveMessage = (eventId: string) => {
    if (!active) return;
    setChatError("");
    void api<Session>(`/sessions/${active.id}/live/promote`, { eventId }).then(adoptSession).catch((error) => {
      setChatError(error instanceof Error ? error.message : String(error));
    });
  };
  const send = (executeRecommendation = false, message = prompt) => {
    if (isUsageCommand(message)) { setModal("usage"); setPrompt(""); setSlash(undefined); return Promise.resolve(); }
    if (active?.status === "running") return sendWhileRunning(message);
    if ((!message.trim() && !attachments.length) || !canSendBase || !attachmentsReady || sending.current) return Promise.resolve();
    sending.current = true;
    const sentAttachments = attachments;
    const visibleMessage = message;
    message = promptWithAttachments(message, sentAttachments);
    setChatError("");
    return safe(async () => {
      try {
        if (active) {
          await api(`/sessions/${active.id}/messages`, { prompt: message, skills: messageSkills, mode: active.mode ?? "manual", autoSwitch });
        } else {
          const s = await submitSession(api, {
            prompt: message, agent, workers, cwd, model, reasoningEffort: reasoningEffort || undefined,
            workerConfigs: normalizeWorkerConfigs(workers, workerConfigs),
            skills: [...new Set([...skills, ...messageSkills])], groupId: groupId || undefined,
            systemPrompt, mode, autoSwitch, workspaceId,
          }, executeRecommendation ? pendingRecommendation : undefined, setRouting);
          setSessions((old) => [s, ...old.filter((x) => x.id !== s.id)]);
          setSelected(s.id);
        }
        storeSentPrompt(visibleMessage);
        clearComposer(sentAttachments);
      } catch (error) {
        setChatError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }).finally(() => {
      sending.current = false;
    });
  };
  const chooseAgent = (id: AgentId) => {
    if (!allowedAgents.includes(id)) return;
    setAgent(id);
    if (id !== agent) {
      setModel("");
      setReasoningEffort("");
    }

  };
  const attachSkill = (skill: Skill) => {
    if (!slash || messageSkills.length >= 20 || new Set([...skills, ...messageSkills, skill.id]).size > 20) return;
    const insertion = `/${skill.name} `;
    const next = prompt.slice(0, slash.start) + insertion + prompt.slice(slash.end);
    const cursor = slash.start + insertion.length;
    setPrompt(next);
    setMessageSkills((old) => [...new Set([...old, skill.id])]);
    setSlash(undefined);
    requestAnimationFrame(() => {
      composerInput.current?.focus();
      composerInput.current?.setSelectionRange(cursor, cursor);
    });
  };
  const attachFile = (file: string) => {
    if (!fileCompletion) return;
    const insertion = `@${file} `;
    const next = prompt.slice(0, fileCompletion.start) + insertion + prompt.slice(fileCompletion.end);
    const cursor = fileCompletion.start + insertion.length;
    setPrompt(next);
    setFileCompletion(undefined);
    setFileSuggestions([]);
    requestAnimationFrame(() => {
      composerInput.current?.focus();
      composerInput.current?.setSelectionRange(cursor, cursor);
    });
  };
  useEffect(() => {
    if (!active || active.status !== "running") return;
    const sessionId = active.id;
    const handle = (event: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(event) || browserOwnsFocus()) return;
      if (event.defaultPrevented || modal || slash || fileCompletion) return;
      const focused = document.activeElement;
      const controlSelection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? focused.selectionStart !== focused.selectionEnd
        : false;
      const pageSelection = Boolean(window.getSelection()?.toString());
      const stopKey = event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c" && !controlSelection && !pageSelection);
      if (!stopKey) return;
      event.preventDefault();
      void safe(async () => { await api(`/sessions/${sessionId}/stop`, {}); });
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active?.id, active?.status, modal, Boolean(slash), Boolean(fileCompletion)]);
  const assignGroup = async (sessionId: string, nextGroup: string | null) => {
    const updated = await api<Session>(`/sessions/${sessionId}/group`, { groupId: nextGroup }, "PATCH");
    setSessions((old) => old.map((session) => session.id === updated.id ? updated : session));
  };
  const elapsed = (s: Session) => {
    const sec = Math.max(
      0,
      Math.floor(
        ((s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.createdAt)) /
          1000,
      ),
    );
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  };
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const handle = (e: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(e)) return;
      if (e.defaultPrevented) return;
      if (e.key === "Escape") setModal(undefined);
      if (e.key === "Tab") {
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not(:disabled), .modal input:not(:disabled), .modal textarea:not(:disabled)",
          ),
        ).filter((element) => element.tabIndex >= 0);
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    document.querySelector<HTMLElement>(".modal button")?.focus();
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [modal]);
  const newSession = () => {
    setSelected(undefined);
    setWorkerSelection(undefined);
    setActivityOpen(false);
    setRecommendation(undefined);
    setTab("workspace");
    setPrompt("");
    setError("");
    setMessageSkills([]);
    setSlash(undefined);
  };
  const returnCandidate = quotaReturnCandidate(active, quotaProviders, quotaThreshold, allowedAgents, now);
  const tasks = active ? delegationTasks(active, now) : [];
  const conversationEvents = active ? mainConversation(active) : [];
  const latestAssistant = [...conversationEvents].reverse().find((event) => event.agent !== "user" && event.type === "message" && !event.metadata?.live);
  const choiceOptions = latestAssistant && active?.status !== "running" ? numberedOptions(conversationText(latestAssistant.text)) : [];
  const streamingMessageId = streamingAssistantMessageId(conversationEvents.map((event) => ({ id: event.id, type: event.type, agent: event.agent, aside: Boolean(event.metadata?.live) })), active?.status === "running");
  const selectedWorker = active && workerSelection?.sessionId === active.id ? delegationWorkers(active, now).find((worker) => worker.id === workerSelection.taskId) : undefined;
  const selectConversation = (id: string) => { setSelected(id); setWorkerSelection(undefined); setTab("workspace"); };
  const selectWorker = (sessionId: string, taskId: string) => { setSelected(sessionId); setWorkerSelection({ sessionId, taskId }); setTab("workspace"); };
  const activityEvents = workerLogRows(active?.events ?? []).filter((row) => row.type !== "message" && row.type !== "delegation").slice(-30);
  const automaticTeam = automaticTeamDefaults(
    workspaceId,
    boot.agents.length ? availableAgents : allowedAgents,
    quotaProviders,
    quotaFallback,
    quotaThreshold,
    now,
    routingSettings ? {
      grok: routingSettings.modelOptions.grok.authStatus,
      claude: routingSettings.modelOptions.claude.authStatus,
      codex: routingSettings.modelOptions.codex.authStatus,
    } : undefined,
  );
  const teamOrchestrator = active
    ? { agent: active.agent, model: active.model, reasoningEffort: active.reasoningEffort }
    : pendingRecommendation?.orchestrator ?? (mode === "auto" ? automaticTeam : { agent, model, reasoningEffort });
  const teamWorkers = active ? normalizeWorkerConfigs(active.workers, active.workerConfigs) : pendingRecommendation?.workers ?? normalizeWorkerConfigs(workers, workerConfigs);
  return (
    <WorkspaceAgentPolicy.Provider value={{ workspaceId, allowedAgents }}>
    <MarkdownSessionContext.Provider value={active?.id}>
    <ViewerContext.Provider value={viewerApi}>
    <MotionConfig reducedMotion="user">
      <div style={{ "--terminal-height": `${terminalHeight}px` } as React.CSSProperties} className={`app-shell ${railHidden ? "sidebar-collapsed" : "sidebar-expanded"}${isTauri() ? " tauri-app" : ""} desk-${desktopMode}${chatCollapsed && desktopMode !== "max" ? " chat-collapsed" : ""}`}>
        <WindowHeader title={tab === "tools" ? "도구 관리" : active?.title} workspaceId={workspaceId} onSwitchWorkspace={onSwitchWorkspace} otherRunning={otherRunning} onTools={() => setTab("tools")} toolsActive={tab === "tools"} onTerminal={() => toggleTerminal()} notifications={<NotificationsCenter workspaceId={workspaceId} cwd={shownCwd} onSession={selectConversation} onRefreshAuth={() => { void refreshModels(); }} />} />
        <TerminalPanel storageKey={workspaceId} cwd={shownCwd} homeCwd={boot.homeCwd} onHeightChange={setTerminalHeight} />
        {railHidden && <button type="button" className="sidebar-handle" aria-label="사이드바 펼치기" title="사이드바 펼치기 (⌘ / Ctrl+B)" onClick={expandSidebar}><ChevronRight size={14} aria-hidden /></button>}
        <Sidebar key={workspaceId} workspaceId={workspaceId} onSwitchWorkspace={onSwitchWorkspace} otherRunning={otherRunning} collapsed={false} hiddenRail={railHidden} onToggle={toggleSidebar} tab={tab} onNavigate={setTab} onSkills={() => { setSkillReturn(undefined); setModal("skills"); }} connected={connected} sessions={sessions} groups={groups} busy={busy} selected={selected}
          onNew={(id) => { newSession(); setGroupId(id ?? ""); }} selectedWorker={selectedWorker?.id} onSelectWorker={selectWorker} onSelect={selectConversation} onHelp={() => setModal("help")} onUsage={() => setModal("usage")}
          onCreateGroup={(name) => safe(async () => {
            const group = await api<Group>("/groups", { name, workspaceId });
            setBoot((old) => ({ ...old, groups: [...old.groups.filter((item) => item.id !== group.id), group] }));
          })}
          onRenameGroup={(id, name) => safe(async () => {
            const group = await api<Group>(`/groups/${id}`, { name }, "PATCH");
            setBoot((old) => ({ ...old, groups: old.groups.map((item) => item.id === id ? group : item) }));
          })}
          onDeleteGroup={(id) => safe(async () => {
            await api(`/groups/${id}`, undefined, "DELETE");
            setBoot((old) => ({ ...old, groups: old.groups.filter((item) => item.id !== id) }));
            setSessions((old) => old.map((session) => session.groupId === id ? { ...session, groupId: undefined } : session));
            if (groupId === id) setGroupId("");
          })}
          onMoveSession={(id) => safe(async () => {
            const updated = await api<Session>(`/sessions/${id}/workspace`, { workspaceId: workspaceId === "personal" ? "company" : "personal" }, "PATCH");
            setSessions((old) => old.map((session) => session.id === id ? updated : session));
            if (selected === id) { newSession(); setGroupId(""); }
          })}
          onMoveGroup={(id) => safe(async () => {
            const target = workspaceId === "personal" ? "company" : "personal";
            await api(`/groups/${id}/workspace`, { workspaceId: target }, "PATCH");
            setBoot((old) => ({ ...old, groups: old.groups.map((group) => group.id === id ? { ...group, workspaceId: target } : group) }));
            setSessions((old) => old.map((session) => session.groupId === id ? { ...session, workspaceId: target } : session));
            if (active?.groupId === id) newSession();
            if (groupId === id) setGroupId("");
          })}
          onAssign={(id, group) => safe(() => assignGroup(id, group))}
          onRenameSession={(id, title) => safe(async () => {
            const updated = await api<Session>(`/sessions/${id}`, { title }, "PATCH");
            setSessions((old) => old.map((session) => session.id === id ? updated : session));
          })}
          onDeleteWorker={(sessionId, workerId) => safe(async () => {
            const updated = await api<Session>(`/sessions/${sessionId}/workers/${encodeURIComponent(workerId)}`, undefined, "DELETE");
            setSessions((old) => old.map((session) => session.id === updated.id ? updated : session));
            setWorkerSelection((current) => current?.sessionId === sessionId && current.taskId === workerId ? undefined : current);
          })}
          onDeleteSession={(id) => safe(async () => {
            await api(`/sessions/${id}`, undefined, "DELETE");
            setSessions((old) => old.filter((session) => session.id !== id));
            if (selected === id) newSession();
          })} />
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {active && active.status !== "running"
            ? `${names[active.agent]} ${statusLabels[active.status]}: ${
                active.events
                  .filter(
                    (event) =>
                      (event.type === "message" || event.type === "error") &&
                      event.agent !== "user",
                  )
                  .at(-1)
                  ?.text.slice(0, 2000) ?? ""
              }`
            : ""}
        </div>
        <BrowserDesktop onAttach={addAttachments} request={desktopRequest} onModeChange={setDesktopMode} />
        {chatCollapsed && desktopMode !== "max" && <aside className="chat-rail" aria-label="접힌 채팅">
          <button type="button" onClick={() => setChatCollapsed(false)} aria-label="채팅 펼치기 (⌘⇧J)" title="채팅 펼치기 (⌘⇧J)"><PanelRightOpen size={18} /><MessageSquare size={18} /><span>채팅</span></button>
        </aside>}
        {desktopMode === "max" && !chatWidgetOpen && <button type="button" className="chat-bubble" onClick={() => setChatWidgetOpen(true)} aria-label="채팅 열기 (⌘⇧J)" title="채팅 열기 (⌘⇧J)">
          <MessageSquare size={22} />{active?.status === "running" && <span className="chat-bubble-dot" />}
        </button>}
        <main className={`${tab === "workspace" ? "chat-view" : "management-view"}${desktopMode === "max" ? (chatWidgetOpen ? " chat-float" : " chat-hidden") : ""}`}>
          {desktopMode === "max" && chatWidgetOpen && <button type="button" className="chat-float-close" onClick={() => setChatWidgetOpen(false)} aria-label="채팅 접기 (⌘⇧J)" title="채팅 접기 (⌘⇧J)"><ChevronDown size={16} /></button>}
          {tab === "routing" && <section className="glass routing-settings" aria-label="허용 에이전트">
            <h2>{workspaceId === "company" ? "회사" : "개인"} 공간 · 허용 에이전트</h2>
            <p className="muted">이 공간의 총괄, 작업자, 계획 담당과 라우터에 적용됩니다.</p>
            <div className="routing-skills">{(["codex", "claude", "grok"] as AgentId[]).map((id) => <label key={id} title={workspaceId === "company" && id === "codex" ? "회사 공간에서는 사용 안 함" : undefined}>
              <input type="checkbox" checked={allowedAgents.includes(id)} disabled={busy || (workspaceId === "company" && id === "codex")} onChange={(event) => {
                const next = event.target.checked ? [...allowedAgents, id] : allowedAgents.filter((item) => item !== id);
                setAllowedAgents(next);
                const team = workspaceTeamDefaults(workspaceId, { agent, workers, model, reasoningEffort, workerConfigs, allowedAgents: next });
                setAgent(team.agent); setWorkers(team.workers); setModel(team.model ?? ""); setReasoningEffort(team.reasoningEffort ?? "");
                setWorkerConfigs(normalizeWorkerConfigs(team.workers, team.workerConfigs));
                setRecommendation(undefined);
              }} /><AgentMark agent={id} size="small" />{names[id]}{workspaceId === "company" && id === "codex" && <small>회사 공간에서는 사용 안 함</small>}
            </label>)}</div>
            <div className="quota-fallback-settings">
              <label className="auto-switch-setting"><span>한도 소진 시 자동 전환</span><input type="checkbox" checked={quotaFallback} disabled={busy} onChange={(event) => setQuotaFallback(event.target.checked)} /></label>
              <label className="quota-threshold">전환 기준 · 남은 한도 (%)<input type="number" min="0" max="100" step="0.5" value={quotaThreshold} disabled={busy || !quotaFallback} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setQuotaThreshold(Math.max(0, Math.min(100, value))); }} /></label>
              <p className="muted">로그인한 허용 에이전트 중 남은 한도가 많은 순서로 전환합니다. 한도가 같거나 확인되지 않으면 아래 순서를 따릅니다.</p>
              {allowedAgents.map((source) => {
                const candidates = (source === "codex" ? ["claude", "grok"] : source === "claude" ? ["codex", "grok"] : ["claude", "codex"]).filter((id) => allowedAgents.includes(id as AgentId)) as AgentId[];
                if (!candidates.length) return null;
                const first = fallbackOrder[source]?.find((id) => candidates.includes(id)) ?? candidates[0];
                return <GlassSelect key={source} label={`${names[source]} 전환 우선순위`} value={first} disabled={busy || !quotaFallback} onChange={(value) => setFallbackOrder((old) => ({ ...old, [source]: [value as AgentId, ...candidates.filter((id) => id !== value)] }))} options={candidates.map((id) => ({ value: id, label: [id, ...candidates.filter((other) => other !== id)].map((target) => names[target]).join(" → "), icon: <AgentMark agent={id} size="small" /> }))} />;
              })}
            </div>
            {!allowedAgents.length && <p role="status">팀 실행에는 에이전트를 한 개 이상 허용해야 합니다.</p>}
          </section>}
          {tab === "routing" && (routingSettings ? <RoutingSettingsPage value={routingSettings} busy={busy} onSave={async (next) => {
            setBusy(true); setError("");
            try { setRoutingSettings(await api<RoutingSettings>("/settings", next, "PUT")); }
            finally { setBusy(false); }
          }} onRefresh={async () => {
            const next = await api<RoutingSettings>("/settings/models/refresh", {}, "POST");
            setRoutingSettings(next);
            setRecommendation(undefined);
            return next;
          }} /> : <section className="glass routing-settings"><p>설정을 불러오지 못했습니다.</p><button className="button light" onClick={() => void load()}>다시 불러오기</button></section>)}
          {tab === "tools" && <ToolsPanel workspaceId={workspaceId} cwd={shownCwd} onChange={() => {
            void api<Skill[]>(`/skills?cwd=${encodeURIComponent(shownCwd)}&workspace=${encodeURIComponent(workspaceId)}`).then((next) => {
              const available = new Set(next.map((skill) => skill.id));
              setBoot((old) => ({ ...old, skills: next }));
              setSkills((old) => old.filter((id) => available.has(id)));
              setMessageSkills((old) => old.filter((id) => available.has(id)));
            }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          }} />}
          {tab === "workspace" && (
            <>

              <div className={`workspace-grid ${activityOpen ? "activity-open" : ""}`}>
                <section className={`glass conversation${dragging ? " drop-target" : ""}`} {...dropHandlers}>
                  {dragging && <div className="drop-overlay"><strong>여기에 놓으면 첨부됩니다</strong><span>이미지, 문서, 동영상, 음성</span></div>}
                  <div className="panel-header">
                    <div>
                      <MessageSquare size={17} />
                      <h2>{selectedWorker ? "작업 세션" : "대화"}</h2>
                      <span className="subtle-tag">
                        {(active || mode === "manual") && <AgentMark agent={selectedWorker?.agent ?? active?.agent ?? agent} size="small" />}{selectedWorker ? selectedWorker.label : active ? names[active.agent] : mode === "auto" ? "자동 배정" : names[agent]}{(selectedWorker || active || mode === "manual") && <RemainingChip agent={selectedWorker?.agent ?? active?.agent ?? agent} />}
                      </span>
                    </div>
                    <div className="chat-actions">
                      {selectedWorker && active && <button className="button light" onClick={() => selectConversation(active.id)}>대화로 돌아가기</button>}
                      {active?.status === "running" && <button className="button light" disabled={busy} onClick={() => void safe(async () => { await api(`/sessions/${active.id}/stop`, {}); })}><Square size={12} />중지</button>}
                      <button className="icon-button" aria-label="브라우저 (⌘⇧B)" title="브라우저 (⌘⇧B) · 요소 선택 ⌘⇧C · 창 배치 ⌃⌥←/→/↑" onClick={() => showBrowser(false)}><Globe size={18} /></button>
                      {desktopMode !== "max" && <button className="icon-button" aria-label="채팅 접기 (⌘⇧J)" title="채팅 접기 (⌘⇧J)" onClick={() => setChatCollapsed(true)}><PanelRightClose size={18} /></button>}
                      <button className="icon-button" aria-label="실시간 활동" aria-expanded={activityOpen} aria-controls="activity-panel" onClick={() => setActivityOpen((value) => !value)}><Activity size={18} /></button>
                    </div>
                  </div>
                  <TeamBar key={active?.id ?? "new"} orchestrator={teamOrchestrator} workers={teamWorkers} settings={routingSettings} availableAgents={boot.agents.length ? availableAgents : allowedAgents} disabled={busy} running={active?.status === "running"} automatic={!active && mode === "auto" && !pendingRecommendation} onSave={(next, crew) => safe(async () => {
                    if (active) {
                      const updated = await api<Session>(`/sessions/${active.id}/team`, { ...next, workers: crew.map((worker) => worker.agent), workerConfigs: crew }, "PATCH");
                      setSessions((old) => old.map((session) => session.id === updated.id ? updated : session));
                    } else if (pendingRecommendation) {
                      setRecommendation({ key: routingKey, value: { ...pendingRecommendation, orchestrator: next, workers: crew } });
                    } else {
                      setAgent(next.agent); setModel(next.model ?? ""); setReasoningEffort(next.reasoningEffort ?? "");
                      setWorkers(crew.map((worker) => worker.agent)); setWorkerConfigs(crew); setMode("manual");
                    }
                  })} />
                  {returnCandidate && active && <div className="quota-return-banner" role="status">
                    <span>{names[returnCandidate.metadata!.from!]} 한도가 초기화되었습니다.</span>
                    <button className="button light" disabled={busy} onClick={() => void safe(async () => {
                      const updated = await api<Session>(`/sessions/${active.id}/quota/return`, { eventId: returnCandidate.id });
                      setSessions((old) => old.map((session) => session.id === updated.id ? updated : session));
                    })}>{names[returnCandidate.metadata!.from!]}로 돌아가기</button>
                  </div>}
                  <div ref={chatBody} className={`chat-body ${!active && !pendingRecommendation ? "empty-chat" : ""}`} onScroll={(event) => {
                    const nearBottom = isNearChatBottom(event.currentTarget);
                    followsChatBottom.current = nearBottom;
                    setShowChatBottom(!nearBottom);
                  }}>
                    {selectedWorker ? <><WorkerThread key={`${active?.id}-${selectedWorker.id}`} worker={selectedWorker} /><div ref={bottom} /></> : !active ? (
                      pendingRecommendation ? <div className="messages routing-message">
                        <div className="message user-message"><div className="message-author"><strong>나</strong></div><div className="message-text">{prompt}</div></div>
                        <RecommendationCard value={pendingRecommendation} settings={routingSettings} skills={boot.skills} editing={editingRecommendation} busy={busy} runDisabled={!canSend || Boolean(unavailableWarning)} availableAgents={boot.agents.length ? availableAgents : allowedAgents} onEdit={() => setEditingRecommendation((old) => !old)} onChange={(value) => setRecommendation({ key: routingKey, value })} onRun={() => void send(true)} />
                        <div ref={bottom} />
                      </div> : <div className="minimal-empty">
                        <h2>무엇을 도와드릴까요?</h2>
                        <div className="prompt-chips">
                          {[
                            ["앱 만들기", "새 앱을 기획하고 만드는 것을 도와주세요. 먼저 작업 폴더를 살펴보고 계획을 제안해 주세요."],
                            ["코드 살펴보기", "이 코드의 구조를 살펴보고 설명해 주세요. 다음으로 가장 도움이 될 개선 사항을 찾아 주세요."],
                            ["팀과 작업하기", "선택한 작업 에이전트와 함께 이 프로젝트를 검토해 주세요. 독립적인 검토 영역을 나누어 맡기고 결과를 요약해 주세요."],
                          ].map(([label, text]) => <button key={label} onClick={() => { setPrompt(text); composerInput.current?.focus(); }}>{label}</button>)}
                        </div>
                      </div>
                    ) : (
                      <div className="messages">
                        {conversationEvents.map((e) => {
                          if (e.type === "handoff") return <div className="handoff-divider" key={e.id}>
                            <span className="agent-label"><AgentMark agent={e.agent} size="small" />{e.text}</span>
                            {e.metadata?.auto && !e.metadata.quotaFallback && e.id === latestHandoffId && <button className="handoff-undo" disabled={busy || !canUndoAutoHandoff(e, active.status, latestHandoffId)} onClick={() => void safe(async () => {
                              const updated = await api<Session>(`/sessions/${active.id}/handoff/undo`, { eventId: e.id });
                              setSessions((old) => old.map((session) => session.id === updated.id ? updated : session));
                            })}>{e.metadata.undone ? "되돌림" : "되돌리기"}</button>}
                          </div>;
                          if (e.type === "delegation") {
                            const task = tasks.find((item) => item.event.id === e.id)!;
                            const config = task.event.role ? task.event : active.workerConfigs?.find((item) => item.agent === task.event.agent);
                            if (e.metadata?.deletedWorker) return <article className="delegation-card deleted-worker" key={e.id} aria-label="삭제된 워커의 작업 위임">
                              <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>작업 위임 · 삭제된 워커</span><strong>{task.event.workerLabel ?? names[task.event.agent]} <em>(삭제된 워커)</em></strong></div><span className="status-label stopped">삭제됨</span></div>
                              <h3>{e.text.replace(/^.*?에게 위임:\s*/, "")}</h3>
                              <div className="delegation-bottom"><p>작업 로그가 삭제되었습니다. 다음 위임은 새 세션으로 시작합니다.</p></div>
                            </article>;
                            return <article className="delegation-card" key={e.id} aria-label="작업 위임">
                              <div className="delegation-heading"><AgentMark agent={task.event.agent} /><div><span>작업 위임</span><strong>{task.event.workerLabel ?? names[task.event.agent]} · {config?.model || "CLI 기본 모델"} · {config?.reasoningEffort || "기본 추론"}</strong></div><span className={`status-label ${task.status}`}>{statusLabels[task.status]}</span><time>{task.elapsed}</time></div>
                              <h3>{e.text.replace(/^.*?에게 위임:\s*/, "")}</h3>
                              <div className="delegation-bottom"><p title={task.activity}>{task.activity}</p><button className="button light" aria-controls={`sidebar-worker-${active.id}-${task.event.workerId ?? task.event.agent}`} onClick={() => { selectWorker(active.id, task.event.workerId ?? task.event.agent); expandSidebar(); }}>작업 보기<ArrowRight size={13} /></button></div>
                            </article>;
                          }
                          const isUser = e.agent === "user";
                          const text = isUser ? e.text : conversationText(e.text);
                          const copied = isUser ? (parseAttachmentMessage(text).body || text) : text;
                          const liveBadge = liveBadgeLabel(e);
                          return <article className={`message ${isUser ? "user-message" : "assistant-message"}${streamingMessageId === e.id ? " streaming-message" : ""}`} key={e.id}>
                            <div className="message-author">
                              {isUser ? <span className="user-avatar">나</span> : <AgentMark agent={e.agent} />}
                              <strong>{names[e.agent] || e.agent}</strong>
                              {liveBadge && <em className={`live-status-badge${liveBadge === "지시" ? " directive" : ""}`}>{liveBadge}</em>}
                              <time>{new Date(e.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
                              <CopyButton text={copied} className="message-copy" ariaLabel={`${names[e.agent] || e.agent} 메시지 복사`} />
                            </div>
                            <div className={`message-text ${e.type === "error" ? "error-banner" : e.type === "warning" ? "warning-banner" : ""}`} role={e.type === "error" || e.type === "warning" ? "alert" : undefined}>{isUser ? <UserMessageBody text={text} /> : <MessageFold text={text} streaming={streamingMessageId === e.id}><Markdown text={text} /></MessageFold>}</div>
                            {canPromoteLive(e) && <button type="button" className="button light live-promote" onClick={() => promoteLiveMessage(e.id)}>지시로 넣을까요?</button>}
                            {!isUser && e.id === latestAssistant?.id && choiceOptions.length > 0 && <div className="message-options" aria-label="응답 선택지">
                              {choiceOptions.map((option, index) => <button type="button" key={option} onClick={() => void send(false, option)}><span>{index + 1}</span>{option}</button>)}
                            </div>}
                          </article>;
                        })}
                        {active.status === "running" && (
                          <div className="thinking" role="status">
                            <LoaderCircle size={14} className="spin" /> 팀이 작업 중입니다…
                          </div>
                        )}
                        <div ref={bottom} />
                      </div>
                    )}
                  </div>
                  {showChatBottom && !selectedWorker && <button type="button" className="chat-bottom-button" onClick={() => scrollToChatBottom()}><ArrowDown size={15} />맨 아래로</button>}
                  {!selectedWorker && <div className="composer-area">
                    {routing && <div className="thinking" role="status"><LoaderCircle size={14} className="spin" /> 팀 고르는 중…</div>}
                    {liveNote && <div className="thinking" role="status"><LoaderCircle size={14} className="spin" /> {liveNote}</div>}
                    {chatError && <div className="message error-banner" role="alert">{chatError}</div>}
                    {unavailableWarning && <p className="composer-warning" role="alert">{unavailableWarning}</p>}
                    <div className={`composer${dragging ? " drop-target" : ""}`}>
                      {slash && (
                        <ComposerPopover anchor={composerInput}>
                          {(!slash.query || "usage".startsWith(slash.query.toLowerCase())) && <button type="button" role="option" aria-selected={false} onPointerDown={(event) => event.preventDefault()} onClick={() => { setModal("usage"); setPrompt(prompt.slice(0, slash.start) + prompt.slice(slash.end)); setSlash(undefined); }}><strong>/usage</strong><small>에이전트·모델별 사용량 보기</small></button>}
                          <div className="slash-heading">스킬 선택 · ↑↓ 이동 · Enter 첨부 · Esc 닫기</div>
                          {filteredSkills.length ? filteredSkills.map((skill, index) => (
                            <button type="button" role="option" id={`slash-skill-${index}`} aria-selected={highlightedSkill === index}
                              disabled={new Set([...skills, ...messageSkills, skill.id]).size > 20}
                              className={highlightedSkill === index ? "highlighted" : ""} key={skill.id}
                              onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => attachSkill(skill)}>
                              <strong>{skill.name}</strong><small>{skill.description || skill.source}</small>
                            </button>
                          )) : <p role="status">일치하는 스킬이 없습니다.</p>}
                          {new Set([...skills, ...messageSkills]).size >= 20 && <p role="status">스킬은 최대 20개까지 첨부할 수 있습니다.</p>}
                        </ComposerPopover>
                      )}
                      {fileCompletion && (
                        <ComposerPopover anchor={composerInput}>
                          <div className="slash-heading">파일 선택 · ↑↓ 이동 · Tab/Enter 삽입 · Esc 닫기</div>
                          {fileSuggestions.length ? fileSuggestions.map((file, index) => <button type="button" role="option" id={`file-suggestion-${index}`} aria-selected={fileIndex === index}
                            className={fileIndex === index ? "highlighted" : ""} key={file}
                            onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => attachFile(file)}>
                            <strong>@{file}</strong>
                          </button>) : <p role="status">일치하는 파일이 없습니다.</p>}
                        </ComposerPopover>
                      )}
                      {attachments.length > 0 && <div className="composer-attachments" aria-label="첨부">
                        {attachments.map((item) => {
                          const remove = () => { uploads.current.get(item.id)?.abort(); if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview); setAttachments((old) => old.filter((other) => other.id !== item.id)); };
                          if (item.kind === "element") return <span key={item.id} className="attachment-chip" tabIndex={0}>
                            <MousePointerClick size={14} />
                            <span className="attachment-chip-label">{item.label}{item.element?.comment ? ` · ${item.element.comment}` : ""}</span>
                            <button type="button" aria-label={`${item.label} 첨부 해제`} onClick={remove}><X size={13} /></button>
                            <span className="attachment-preview" role="tooltip">
                              {item.preview && <img src={item.preview} alt="" />}
                              {item.element && <><b>{item.element.selector}</b><small>{item.element.url}</small>{item.element.react?.name && <small>React: {(item.element.react.chain ?? [item.element.react.name]).join(" ← ")}{item.element.react.source ? ` · ${item.element.react.source}` : ""}</small>}{item.element.comment && <em>“{item.element.comment}”</em>}</>}
                            </span>
                          </span>;
                          const openPath = item.screenshotPath || item.preview;
                          const kind = item.kind === "image" ? "image" as const : kindFromName(item.screenshotPath || item.label);
                          return <span key={item.id} className={`file-chip composer-file-chip${item.error ? " chip-error" : ""}`}>
                            <button type="button" className="composer-file-open" disabled={!openPath} onClick={() => openPath && openViewer([{ path: openPath, name: item.label, kind: kind === "unknown" ? "text" : kind }], 0)}>
                              {item.preview ? <img className="composer-file-thumb" src={item.preview} alt="" /> : <FileText size={18} />}
                              <span className="file-chip-copy">
                                <span className="file-chip-name">{item.label}</span>
                                <span className="file-chip-meta"><span>{item.error || kindLabel(kind === "unknown" ? "text" : kind)}</span>{item.size != null && !item.error && <span>{formatBytes(item.size)}</span>}</span>
                              </span>
                            </button>
                            <button type="button" className="chip-remove" aria-label={`${item.label} 첨부 해제`} onClick={remove}><X size={13} /></button>
                            {item.progress != null && <span className="upload-progress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}
                          </span>;
                        })}
                      </div>}
                      {messageSkills.length > 0 && <div className="message-skills" aria-label="이 메시지의 스킬">
                        {messageSkills.map((id) => <button key={id} onClick={() => setMessageSkills((old) => old.filter((item) => item !== id))}
                          aria-label={`${boot.skills.find((skill) => skill.id === id)?.name ?? id} 첨부 해제`}>
                          <WandSparkles size={12} />{boot.skills.find((skill) => skill.id === id)?.name ?? id}<X size={12} />
                        </button>)}
                      </div>}
                      <textarea
                        ref={composerInput}
                        disabled={composerLocked(sessionRunning, busy)}
                        onPaste={pasteImage}
                        aria-controls={slash || fileCompletion ? "slash-skills" : undefined}
                        aria-expanded={Boolean(slash || fileCompletion)}
                        aria-autocomplete="list"
                        onBlur={() => { setSlash(undefined); setFileCompletion(undefined); }}
                        aria-activedescendant={slash && filteredSkills.length ? `slash-skill-${highlightedSkill}` : fileCompletion && fileSuggestions.length ? `file-suggestion-${fileIndex}` : undefined}
                        aria-label="총괄 에이전트에게 보낼 메시지"
                        placeholder={sessionRunning ? "진행 중에도 물을 수 있습니다. 상태 질문, 다음 지시, 또는 중지…" : !active && mode === "auto" ? "무엇을 도와드릴까요? 요청을 입력하면 알맞은 팀이 작업을 시작합니다…" : `${active ? names[active.agent] : names[agent]}에게 구현, 탐색, 수정을 요청해 보세요…`}
                        value={prompt}
                        onChange={(e) => {
                          setPrompt(e.target.value);
                          setSlash(slashToken(e.target.value, e.target.selectionStart));
                          setFileCompletion(fileToken(e.target.value, e.target.selectionStart));
                          setSkillIndex(0);
                          setFileIndex(0);
                          historyIndex.current = -1;
                          historyDraft.current = e.target.value;
                        }}
                        onClick={(e) => {
                          setSlash(slashToken(prompt, e.currentTarget.selectionStart));
                          setFileCompletion(fileToken(prompt, e.currentTarget.selectionStart));
                          setSkillIndex(0); setFileIndex(0);
                        }}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          if (fileCompletion && handlesCompletionKey(e.key, e.shiftKey)) {
                            e.preventDefault();
                            if (e.key === "Escape") setFileCompletion(undefined);
                            else if ((e.key === "Enter" || e.key === "Tab") && fileSuggestions[fileIndex]) attachFile(fileSuggestions[fileIndex]);
                            else if (e.key === "ArrowDown" || e.key === "ArrowUp") setFileIndex((fileIndex + (e.key === "ArrowDown" ? 1 : -1) + fileSuggestions.length) % Math.max(1, fileSuggestions.length));
                            return;
                          }
                          if (slash && handlesCompletionKey(e.key, e.shiftKey)) {
                            e.preventDefault();
                            if (e.key === "Escape") setSlash(undefined);
                            else if (e.key === "Enter" || e.key === "Tab") { if (isUsageCommand(prompt)) { void send(); } else if (filteredSkills[highlightedSkill]) attachSkill(filteredSkills[highlightedSkill]); }
                            else setSkillIndex((highlightedSkill + (e.key === "ArrowDown" ? 1 : -1) + filteredSkills.length) % Math.max(1, filteredSkills.length));
                            return;
                          }
                          if (sessionRunning && (e.key === "Escape" || (e.key.toLowerCase() === "c" && e.ctrlKey && e.currentTarget.selectionStart === e.currentTarget.selectionEnd))) {
                            e.preventDefault();
                            stopActive();
                            return;
                          }
                          if (e.key === "Escape") {
                            const time = Date.now();
                            if (time - lastEscape.current <= 1_000) setPrompt("");
                            lastEscape.current = time;
                            return;
                          }
                          if (!prompt && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
                            const option = choiceOptions[Number(e.key) - 1];
                            if (option) { e.preventDefault(); void send(false, option); }
                            return;
                          }
                          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                            const cursor = e.currentTarget.selectionStart;
                            const onFirstLine = !prompt.slice(0, cursor).includes("\n");
                            const onLastLine = !prompt.slice(cursor).includes("\n");
                            if ((e.key === "ArrowUp" && onFirstLine) || (e.key === "ArrowDown" && onLastLine && historyIndex.current >= 0)) {
                              let globalHistory: string[] = [];
                              try {
                                const stored = JSON.parse(localStorage.getItem("orchestra.promptHistory") ?? "[]");
                                if (Array.isArray(stored)) globalHistory = stored.filter((value): value is string => typeof value === "string");
                              } catch { /* Prompt history is optional. */ }
                              const currentHistory = active ? [...active.events].reverse().filter((event) => event.agent === "user" && event.type === "message").map((event) => event.text) : [];
                              const entries = historyEntries(currentHistory, globalHistory);
                              if (historyIndex.current === -1) historyDraft.current = prompt;
                              const step = historyStep(entries, e.key === "ArrowUp" ? -1 : 1, historyDraft.current, historyIndex.current);
                              e.preventDefault();
                              historyIndex.current = step.index;
                              setPrompt(step.value);
                              requestAnimationFrame(() => composerInput.current?.setSelectionRange(step.value.length, step.value.length));
                              return;
                            }
                          }
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div className="composer-bottom">
                        <button
                          className="directory-button"
                          disabled={Boolean(active)}
                          onClick={() => setModal("directory")}
                          title={
                            active
                              ? "폴더를 변경하려면 새 세션을 시작하세요"
                              : cwd
                          }
                        >
                          <Folder size={14} />
                          <span>
                            {shownCwd
                              ? shownCwd.split("/").filter(Boolean).at(-1) || "/"
                              : "작업 폴더 선택"}
                          </span>
                          <ChevronDown size={12} />
                        </button>
                        {!active && <div className="routing-mode" role="group" aria-label="배정 방식">
                          <button aria-pressed={mode === "auto"} disabled={busy} onClick={() => setMode("auto")}>자동</button>
                          <button aria-pressed={mode === "manual"} disabled={busy} onClick={() => setMode("manual")}>수동</button>
                        </div>}
                        <input ref={fileInput} type="file" multiple hidden onChange={(event) => { attachFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                        <button type="button" className="icon-button" aria-label="파일 첨부" title="파일 첨부" onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
                        <button className="icon-button" aria-label="모델 및 시스템 프롬프트" onClick={() => setModal("settings")}><Settings2 size={16} /></button>
                        <button
                          className="send-button"
                          aria-label={composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length)) === "stop" ? "작업 중지" : routing ? "팀 고르는 중…" : "메시지 보내기"}
                          disabled={composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length)) === "stop" ? busy : !canSend && !isUsageCommand(prompt)}
                          onClick={composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length)) === "stop" ? stopActive : () => void send()}
                        >
                          {composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length)) === "stop" ? (
                            <Square size={16} fill="currentColor" />
                          ) : busy && !sessionRunning ? (
                            <LoaderCircle size={16} className="spin" />
                          ) : (
                            <ArrowUp size={19} />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="composer-hints">실행 중에도 입력 · Enter 전송 · ⇧Enter 줄바꿈 · ↑↓ 기록 · Esc/⌃C 중지 · / 스킬 · @ 파일 · ⌘V·드래그 첨부 · ⌘⇧B 브라우저</div>
                  </div>}
                </section>
                {activityOpen && <aside className="right-column" id="activity-panel" aria-label="실시간 활동">
                  <section className="glass activity-panel">
                    <div className="panel-header">
                      <div>
                        <Radio size={17} />
                        <h2>작업 내역</h2>
                      </div>
                      <span
                        className={`live-badge ${!connected ? "offline" : ""}`}
                        role="status"
                      >
                        <i />
                        {!connected
                          ? "연결 끊김"
                          : active?.status === "running"
                            ? "진행 중"
                            : "대기 중"}
                      </span>
                      <button className="icon-button" aria-label="작업 내역 접기" onClick={() => setActivityOpen(false)}><X size={16} /></button>
                    </div>
                    <div className="activity-content">
                      {!active ? (
                        <div className="activity-empty">
                          <span className="radar">
                            <Radio size={27} />
                          </span>
                          <h3>작업 과정을 한눈에.</h3>
                          <p>
                            명령 실행, 도구 사용, 파일 변경 내역이
                            <br />
                            여기에 실시간으로 표시됩니다.
                          </p>
                          <span>첫 세션을 기다리고 있습니다</span>
                        </div>
                      ) : (
                        <div
                          className="event-list"
                          role="log"
                          aria-label="최근 에이전트 활동"
                          aria-live="off"
                        >
                          {activityEvents.length === 0 && <p className="thread-empty">아직 작업 내역이 없습니다.</p>}
                          {activityEvents.map((row) => <div className={`activity-summary event-${row.type}`} key={row.event.id}>
                            <AgentMark agent={row.event.agent} size="small" /><span title={workerLogSummary(row)}>{row.event.workerLabel ? `${row.event.workerLabel} · ` : ""}{eventLabels[row.type]} · {workerLogSummary(row)}</span>
                            <time>{new Date(row.event.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>
                          </div>)}
                        </div>
                      )}
                    </div>
                    <div className="activity-footer">
                      <Terminal size={13} />
                      <span>실시간 CLI 활동 내역</span>
                      <span className="tiny-dot" />
                    </div>
                  </section>
                </aside>}
              </div>
            </>
          )}
          {tab === "sessions" && (
            <section className="glass full-panel">
              <div className="panel-header">
                <h2>세션 기록</h2>
                <span>
                  전체 {sessions.length}개 · 진행 중 {running}개
                </span>
              </div>
              {sessions.length === 0 ? (
                <div className="page-empty">
                  <Layers size={32} />
                  <h2>다음 아이디어를 여기서 시작하세요.</h2>
                  <p>세션을 시작하고 에이전트의 작업을 확인하세요.</p>
                  <button className="button primary" onClick={newSession}>
                    <Plus size={16} />
                    새 세션
                  </button>
                </div>
              ) : (
                sessions.map((s) => (
                  <div className="history-row" key={s.id}>
                    <AgentMark agent={s.agent} />
                    <button
                      onClick={() => {
                        selectConversation(s.id);
                      }}
                    >
                      <strong>{s.title}</strong>
                      <small>{names[s.agent]} · {s.cwd}</small>
                    </button>
                    <span className={`status-label ${s.status}`}>
                      {statusLabels[s.status]}
                    </span>
                    <time>{elapsed(s)}</time>
                    {s.status === "running" && (
                      <button
                        className="icon-button"
                        title="세션 중지"
                        onClick={() =>
                          void safe(async () => {
                            await api(`/sessions/${s.id}/stop`, {});
                          })
                        }
                      >
                        <Square size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </section>
          )}
          {tab === "bots" && (
            <div className="bots-grid">
              <section className="glass full-panel">
                <div className="panel-header">
                  <h2>내 봇</h2>
                  <button
                    className="button light small"
                    onClick={() => setModal("bot")}
                  >
                    <Plus size={14} />
                    봇 만들기
                  </button>
                </div>
                {!boot.bots.length ? (
                  <div className="page-empty">
                    <Bot size={36} />
                    <h2>에이전트마다 알맞은 역할을.</h2>
                    <p>
                      에이전트, 모델, 스킬, 지침을 봇으로 저장하고
                      언제든 다시 활용하세요.
                    </p>
                    <button
                      className="button primary"
                      onClick={() => setModal("bot")}
                    >
                      첫 봇 만들기 <ArrowRight size={15} />
                    </button>
                  </div>
                ) : (
                  boot.bots.map((b) => (
                    <div className="bot-row" key={b.id}>
                      <AgentMark agent={b.agent} />
                      <div>
                        <strong>{b.name}</strong>
                        <small>
                          {names[b.agent]} · {b.model || "CLI 기본값"} ·{" "}
                          스킬 {b.skills.length}개
                        </small>
                      </div>
                      <button
                        className="icon-button"
                        title="봇 사용"
                        onClick={() => {
                          setMode("manual");
                          chooseAgent(b.agent);
                          setModel(b.model ?? "");
                          setSkills(b.skills);
                          setSystemPrompt(b.systemPrompt);
                          newSession();
                        }}
                      >
                        <ArrowRight size={17} />
                      </button>
                      <button
                        className="icon-button"
                        title="봇 삭제"
                        onClick={() =>
                          void safe(async () => {
                            await api(`/bots/${b.id}`, undefined, "DELETE");
                            await load();
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))
                )}
              </section>
              <section className="glass bot-conversation">
                <h2>대화 시작하기</h2>
                <p>
                  두 봇이 함께 아이디어를 발전시켜 보세요.
                  <br />
                  대화의 방향과 발언 횟수를 정해 주세요.
                </p>
                <label>
                  첫 번째 봇
                  <GlassSelect label="첫 번째 봇" value={botA} onChange={setBotA} options={[{ value: "", label: "봇 선택" }, ...boot.bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
                </label>
                <label>
                  두 번째 봇
                  <GlassSelect label="두 번째 봇" value={botB} onChange={setBotB} options={[{ value: "", label: "봇 선택" }, ...boot.bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
                </label>
                <label>
                  발언 횟수
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={turns}
                    onChange={(e) => setTurns(Number(e.target.value))}
                  />
                </label>
                <label>
                  대화 주제
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="봇이 함께 논의할 주제를 입력하세요"
                  />
                </label>
                <button
                  className="directory-button"
                  onClick={() => setModal("directory")}
                >
                  <Folder size={14} />
                  {cwd.split("/").pop()}
                  <ChevronDown size={12} />
                </button>
                <button
                  className="button primary"
                  disabled={
                    !botA ||
                    !botB ||
                    !prompt.trim() ||
                    busy ||
                    !connected ||
                    !Number.isInteger(turns) ||
                    turns < 1 ||
                    turns > 20
                  }
                  onClick={() =>
                    void safe(async () => {
                      const s = await api<Session>("/conversations", {
                        botA,
                        botB,
                        turns,
                        prompt,
                        cwd,
                      });
                      setSelected(s.id);
                      setSessions((old) => [
                        s,
                        ...old.filter((existing) => existing.id !== s.id),
                      ]);
                      setPrompt("");
                      setTab("workspace");
                    })
                  }
                >
                  <Users size={16} />
                  대화 시작
                </button>
              </section>
            </div>
          )}
        </main>
        {modal && (
          <div className="modal-backdrop" onClick={() => setModal(undefined)}>
            <section
              className={`glass modal ${modal === "usage" ? "usage-modal" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-header">
                <h2 id="modal-title">
                  {modal === "usage" ? "사용량" : modal === "skills"
                    ? "팀 스킬 설정"
                    : modal === "directory"
                      ? "작업 폴더"
                      : modal === "bot"
                        ? "봇 만들기"
                        : modal === "settings"
                          ? "세션 설정"
                          : "내 컴퓨터의 에이전트 팀"}
                </h2>
                <button
                  className="icon-button"
                  onClick={() => setModal(undefined)}
                  aria-label="대화 상자 닫기"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="modal-body">
                {error && (
                  <div className="error-banner" role="alert">
                    {error}
                    <button
                      aria-label="오류 닫기"
                      onClick={() => setError("")}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}
                {modal === "skills" && (
                  <>
                    <p>
                      각 에이전트의 작업 프롬프트에 추가할 스킬을
                      최대 20개까지 선택하세요.
                    </p>
                    <button className="button light" disabled={busy || !shownCwd} onClick={() => void safe(async () => {
                      const next = await api<Skill[]>("/skills/refresh", { cwd: shownCwd, workspace: workspaceId });
                      setBoot((old) => ({ ...old, skills: next }));
                    })}>{busy ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}스킬 새로고침</button>
                    <div className="search-field">
                      <Search size={16} />
                      <input
                        placeholder="스킬 검색…"
                        aria-label="스킬 검색"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <div className="skill-list">
                      {boot.skills
                        .filter((s) =>
                          (s.name + " " + s.source)
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((s) => (
                          <label className="skill-row" key={s.id}>
                            <input
                              type="checkbox"
                              checked={skills.includes(s.id)}
                              disabled={
                                !skills.includes(s.id) && skills.length >= 20
                              }
                              onChange={() =>
                                setSkills((old) =>
                                  old.includes(s.id)
                                    ? old.filter((x) => x !== s.id)
                                    : [...old, s.id],
                                )
                              }
                            />
                            <span>
                              <strong>{s.name}</strong>
                              <small>{s.description || s.source}</small>
                            </span>
                            <span className="source-tag">{s.source}<br />{s.agents?.map((id) => names[id]).join(" · ")}</span>
                          </label>
                        ))}
                      {!boot.skills.length && (
                        <p>
                          스킬을 찾을 수 없습니다. ./skills 또는 에이전트의 스킬 폴더에
                          SKILL.md 파일을 추가한 뒤 새로고침하세요.
                        </p>
                      )}
                    </div>
                    <button
                      className="button primary"
                      onClick={() => {
                        setModal(skillReturn);
                        setSkillReturn(undefined);
                      }}
                    >
                      스킬 {skills.length}개 사용 <Check size={15} />
                    </button>
                  </>
                )}
                {modal === "usage" && <UsagePanel initialWorkspace={workspaceId} />}
                {modal === "directory" && <FolderPicker key={workspaceId} workspaceId={workspaceId} currentPath={cwd} onUse={(path) => { setCwd(path); setModal(undefined); }} />}
                {(modal === "settings" || modal === "bot") && (
                  <>
                    {modal === "bot" && (
                      <label>
                        봇 이름
                        <input
                          value={botName}
                          onChange={(e) => setBotName(e.target.value)}
                          placeholder="예: 꼼꼼한 코드 검토자"
                        />
                      </label>
                    )}
                    <label>
                      에이전트
                      <GlassSelect label="에이전트" value={agent} disabled={busy} onChange={(value) => chooseAgent(value as AgentId)} options={(["codex", "claude", "grok"] as AgentId[]).map((id) => ({ value: id, label: names[id], icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>, disabled: !allowedAgents.includes(id), title: workspaceId === "company" && id === "codex" ? "회사 공간에서는 사용 안 함" : undefined }))} />
                    </label>
                    <ModelChoice disabled={busy} label="세션 모델" value={{ agent, model, reasoningEffort }} settings={routingSettings} chooseAgent={false} onChange={(next) => { setModel(next.model ?? ""); setReasoningEffort(next.reasoningEffort ?? ""); }} />
                    {modal === "settings" && <label className="auto-switch-setting">
                      <span><strong>대화 중 자동 전환</strong><small>자동 모드에서 작업 종류가 명확히 바뀌면 알맞은 오케스트라로 전환합니다.</small></span>
                      <input type="checkbox" checked={autoSwitch} disabled={busy} onChange={(event) => setAutoSwitch(event.target.checked)} />
                    </label>}
                    {modal === "settings" && <button className="button light" onClick={() => { setModal(undefined); setTab("routing"); }}>자동 라우팅 규칙과 모델 목록 편집</button>}
                    {modal === "settings" && <button className="button light" onClick={() => { setModal(undefined); window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT)); }}>설정 도우미 다시 열기</button>}
                    <label>
                      시스템 지침
                      <textarea
                        rows={5}
                        placeholder="이 에이전트가 어떤 방식으로 작업하면 좋을까요?"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                      />
                    </label>
                    <button
                      className="button light"
                      onClick={() => {
                        setSkillReturn(modal);
                        setModal("skills");
                      }}
                    >
                      <WandSparkles size={15} />
                      스킬 {skills.length}개 선택됨
                    </button>
                    <p className="muted">
                      설정은 새 세션에 적용됩니다. 팀, 스킬, 폴더를
                      변경하려면 새 세션을 시작하세요.
                    </p>
                    <button
                      className="button primary"
                      disabled={busy || (modal === "bot" && !botName.trim())}
                      onClick={() =>
                        modal === "bot"
                          ? void safe(async () => {
                              await api("/bots", {
                                name: botName,
                                agent,
                                model,
                                skills,
                                systemPrompt,
                              });
                              await load();
                              setBotName("");
                              setModal(undefined);
                            })
                          : setModal(undefined)
                      }
                    >
                      {modal === "bot" ? "봇 저장" : "완료"}
                      <Check size={15} />
                    </button>
                  </>
                )}
                {modal === "help" && (
                  <>
                    <button className="button primary onboarding-reopen" onClick={() => { setModal(undefined); window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT)); }}>설정 도우미 다시 열기</button>
                    <p>
                      오케스트라는 설치된 에이전트 CLI를 실행하고
                      활동 내역을 하나의 작업 공간에 실시간으로 표시합니다.
                      총괄 에이전트와 작업 에이전트를 선택한 뒤 작업을 요청하세요.
                    </p>
                    <div className="cli-status-list">
                      {boot.agents.map((a) => (
                        <div key={a.id}>
                          <AgentMark agent={a.id} />
                          <strong>{a.name}</strong>
                          <span
                            className={
                              a.available ? "available" : "unavailable"
                            }
                          >
                            {a.available ? "설치됨" : "사용 불가"}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p>
                      CLI 인증은 터미널에서 완료해야 합니다.
                      도구 권한은 각 CLI의 설정을 따르며,
                      권한을 우회하지 않습니다.
                    </p>
                    <p className="muted">
                      서버: 127.0.0.1:3001 · 화면: {location.host}
                    </p>
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </MotionConfig>
    {viewer && <FileViewer items={viewer.items} index={viewer.index} onIndex={(index) => setViewer({ items: viewer.items, index })} onClose={() => setViewer(null)} />}
    </ViewerContext.Provider>
    </MarkdownSessionContext.Provider>
    </WorkspaceAgentPolicy.Provider>
  );
}
blockHistoryButtons();
const stranded = isStrandedShell(location.href);
// tauri://localhost = boot splash (or the WebView was walked back past the server page): never run the app here.
if (stranded) returnToAppServer();
createRoot(document.getElementById("root")!).render(
  stranded ? <div className="app-booting" role="status" /> : <ErrorBoundary>
    <QuotaProvider><App /></QuotaProvider>
  </ErrorBoundary>,
);
