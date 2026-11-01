import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { Activity, ArrowDown, ChevronDown, ChevronRight, Globe, MessageSquare, PanelRightClose, PanelRightOpen, Square } from "lucide-react";
import { MarkdownSessionContext } from "../markdown-images";
import { isNetworkFailure, teamAvailabilityWarning } from "../team";
import { normalizeWorkerConfigs } from "../../server/workers";
import { WorkspaceAgentPolicy, RecommendationCard, RoutingSettingsPage } from "../RoutingControls";
import type { RoutingSettings, RoutingRecommendation } from "../../server/routing";
import { historyEntries, numberedOptions, recentPaths, isUsageCommand } from "../composer";
import { allowedAgentsForWorkspace } from "../../server/workspace-policy";
import { submitSession } from "../submit";
import { WorkerThread } from "../WorkerThread";
import { workerLogRows } from "../worker-log";
import { Sidebar } from "../Sidebar";
import { inWorkspace, workspaceTeamDefaults } from "../workspaces";
import { readPreference, writePreference, savedBoolean } from "../preferences";
import { AgentMark } from "../AgentMark";
import { TerminalPanel } from "../TerminalPanel";
import { NotificationsCenter } from "../NotificationsCenter";
import { toggleTerminal, terminalOwnsKeyboardEvent, TERMINAL_AUTH_REFRESH_EVENT, TERMINAL_NOTICE_EVENT, type TerminalNotice } from "../terminal-events";
import { BrowserDesktop, type DesktopRequest } from "../BrowserDesktop";
import type { DesktopMode } from "../desktop-windows";
import { holdCommand } from "../browser-agent";
import { browserRegistry } from "../browser-registry";
import { chatShortcut, globalBrowserShortcut, browserOwnsFocus } from "../browser-shortcuts";
import { afterEdgeClick, afterRailToggle, railCollapsed } from "../sidebar-rail";
import { classifyLiveMessage } from "../../server/live-turn";
import { promptWithAttachments, type ComposerAttachment } from "../preview-attachments";
import { isTauri, WindowHeader } from "../WindowHeader";
import { conversationText, delegationTasks, delegationWorkers, mainConversation } from "../conversation";
import { streamingAssistantMessageId } from "../chat-scroll";
import { RemainingChip } from "../QuotaContext";
import { ViewerContext } from "../media-ui";
import { FileViewer } from "../FileViewer";
import type { MediaRef } from "../viewer-model";
import { ToolsPanel, toolsShortcut } from "../ToolsPanel";
import type { WorkspaceId, WorkspaceDefaults, AgentId, AgentSelection, Group, Session, SkillInfo as Skill, Bot as Preset } from "../../server/types";
import { scopedApi, workspaceApi, type Bootstrap } from "./api";
import { names, promptChips, statusLabels } from "./labels";
import type { ServerMessage } from "./socket";
import { adoptSession as adoptInto, replaceSession, upsertPushedSession } from "./session-store";
import { useAppSocket } from "./useAppSocket";
import { useAttachments } from "./useAttachments";
import { useChatScroll } from "./useChatScroll";
import { useComposerCompletion } from "./useComposerCompletion";
import { useModalFocusTrap } from "./useModalFocusTrap";
import { ActivityPanel } from "./ActivityPanel";
import { AllowedAgentsSettings } from "./AllowedAgentsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AppModal } from "./AppModal";
import { BotsView } from "./BotsView";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { QuotaReturnBanner } from "./QuotaReturnBanner";
import { SessionsView } from "./SessionsView";
import { TeamBarSlot } from "./TeamBarSlot";
import { t } from "../i18n";

/** One workspace (personal/company): sessions, chat, browser desktop, terminal and dialogs. */
export function WorkspaceApp({ workspaceId, defaults, onDefaultsChange, onSwitchWorkspace }: {
  workspaceId: WorkspaceId; defaults: WorkspaceDefaults;
  onDefaultsChange: (id: WorkspaceId, defaults: WorkspaceDefaults) => void; onSwitchWorkspace: () => void;
}) {
  const api = useMemo(() => scopedApi(workspaceId), [workspaceId]);
  const [boot, setBoot] = useState<Bootstrap>({
    agents: [],
    skills: [],
    bots: [],
    groups: [],
    defaultCwd: "",
  });
  const [allSessions, setSessions] = useState<Session[]>([]);
  const sessions = useMemo(() => inWorkspace(allSessions, workspaceId), [allSessions, workspaceId]);
  const groups = useMemo(() => inWorkspace(boot.groups, workspaceId), [boot.groups, workspaceId]);
  const otherRunning = useMemo(() => allSessions.filter((session) => session.workspaceId !== workspaceId && session.status === "running").length, [allSessions, workspaceId]);
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
  const [viewer, setViewer] = useState<{ items: MediaRef[]; index: number } | null>(null);
  const openViewer = useCallback((items: MediaRef[], index: number) => setViewer({ items, index }), []);
  const viewerApi = useMemo(() => ({ open: openViewer }), [openViewer]);
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
  const [error, setError] = useState("");
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
  const [botName, setBotName] = useState("");
  const [botA, setBotA] = useState("");
  const [botB, setBotB] = useState("");
  const [turns, setTurns] = useState(4);
  const [activityOpen, setActivityOpen] = useState(false);
  const active = useMemo(() => sessions.find((s) => s.id === selected), [sessions, selected]);
  const shownCwd = active?.cwd ?? cwd;
  const completion = useComposerCompletion(api, boot.skills, messageSkills, shownCwd);
  const { setSlash, setFileCompletion, historyIndex, historyDraft, composerInput } = completion;
  const attachmentState = useAttachments(composerInput, setChatError);
  const { attachments, setAttachments, attachmentsReady, addAttachments, dragging, dropHandlers } = attachmentState;
  useEffect(() => {
    if (selected && allSessions.some((session) => session.id === selected && session.workspaceId !== workspaceId)) {
      setSelected(undefined); setWorkerSelection(undefined); setGroupId(""); setPrompt(""); setRecommendation(undefined);
    }
  }, [allSessions, selected, workspaceId]);
  const latestHandoffId = useMemo(() => active ? [...active.events].reverse().find((event) => event.type === "handoff")?.id : undefined, [active]);
  useEffect(() => { setActivityOpen(false); }, [active?.id]);
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
  useEffect(() => {
    setMessageSkills([]);
    setSlash(undefined);
    setFileCompletion(undefined);
    historyIndex.current = -1;
  }, [selected]);
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
    void workspaceApi("/notifications", { workspaceId, type: "error", title: t("ws.requestError"), body: error, key: `request:${error.slice(0, 100)}` }).catch(() => undefined);
    setError("");
  }, [error, workspaceId]);
  const onServerMessage = (message: ServerMessage) => {
    if (message.type === "notifications") window.dispatchEvent(new Event("orchestra:notifications"));
    if (message.type === "browser-command") window.dispatchEvent(new CustomEvent("orchestra:browser-command", { detail: message }));
    if (message.type === "sessions") setSessions(message.sessions);
    if (message.type === "groups") setBoot((old) => ({ ...old, groups: message.groups }));
    if (message.type === "session_deleted") {
      setSessions((old) => old.filter((session) => session.id !== message.sessionId));
      setSelected((current) => current === message.sessionId ? undefined : current);
    }
    if (message.type === "session") setSessions((old) => upsertPushedSession(old, message.session as Session, Boolean(message.incremental)));
  };
  useEffect(() => { void load(); }, []);
  const connected = useAppSocket(onServerMessage, () => { void load(); });
  const canSendBase = Boolean(
    new Set([...skills, ...messageSkills]).size <= 20 &&
    (sessionRunning || !busy) &&
    allowedAgents.length >= 1 &&
    !(mode === "manual" && unavailableWarning) &&
    connected &&
    (active || mode === "auto" || workers.length),
  );
  const canSend = Boolean((prompt.trim() || attachments.some((item) => item.kind === "element" || item.screenshotPath)) && canSendBase && attachmentsReady);
  const { bottom, chatBody, showChatBottom, scrollToChatBottom, onChatScroll } = useChatScroll({
    resetKey: [selected, workerSelection?.taskId],
    followKey: [active?.events.at(-1)?.id, active?.events.at(-1)?.text, pendingRecommendation, editingRecommendation],
    observeKey: [selected, workerSelection?.taskId, active?.events.length],
  });
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
  const adoptSession = (updated: Session) => setSessions((old) => adoptInto(old, updated));
  const replaceFromServer = (updated: Session) => setSessions((old) => replaceSession(old, updated));
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
  const stopSession = (id: string) => { void safe(async () => { await api(`/sessions/${id}/stop`, {}); }); };
  const stopActive = () => {
    if (!active || active.status !== "running") return;
    stopSession(active.id);
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
    setLiveNote(intent === "directive" ? t("ws.queueingDirective") : t("ws.checkingStatus"));
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
  const { slash, fileCompletion } = completion;
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
    replaceFromServer(updated);
  };
  const closeModal = useCallback(() => setModal(undefined), []);
  useModalFocusTrap(modal, closeModal);
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
  // Derived conversation data: recomputed only when the active session changes, not per render.
  const tasksById = useMemo(() => new Map(active ? delegationTasks(active, Date.now()).map((task) => [task.event.id, task]) : []), [active]);
  const conversationEvents = useMemo(() => active ? mainConversation(active) : [], [active]);
  const latestAssistant = useMemo(() => [...conversationEvents].reverse().find((event) => event.agent !== "user" && event.type === "message" && !event.metadata?.live), [conversationEvents]);
  const choiceOptions = useMemo(() => latestAssistant && active?.status !== "running" ? numberedOptions(conversationText(latestAssistant.text)) : [], [latestAssistant, active?.status]);
  const streamingMessageId = useMemo(() => streamingAssistantMessageId(conversationEvents.map((event) => ({ id: event.id, type: event.type, agent: event.agent, aside: Boolean(event.metadata?.live) })), active?.status === "running"), [conversationEvents, active?.status]);
  const selectedWorker = useMemo(() => active && workerSelection?.sessionId === active.id ? delegationWorkers(active, Date.now()).find((worker) => worker.id === workerSelection.taskId) : undefined, [active, workerSelection]);
  const activityEvents = useMemo(() => workerLogRows(active?.events ?? []).filter((row) => row.type !== "message" && row.type !== "delegation").slice(-30), [active?.events]);
  const lastAnnouncement = useMemo(() => active && active.status !== "running"
    ? `${names[active.agent]} ${statusLabels[active.status]}: ${active.events.filter((event) => (event.type === "message" || event.type === "error") && event.agent !== "user").at(-1)?.text.slice(0, 2000) ?? ""}`
    : "", [active]);
  const selectConversation = (id: string) => { setSelected(id); setWorkerSelection(undefined); setTab("workspace"); };
  const selectWorker = (sessionId: string, taskId: string) => { setSelected(sessionId); setWorkerSelection({ sessionId, taskId }); setTab("workspace"); };
  const teamAgents = boot.agents.length ? availableAgents : allowedAgents;
  const sessionAction = (path: string, body?: unknown, method?: string) => safe(async () => { replaceFromServer(await api<Session>(path, body, method)); });
  return (
    <WorkspaceAgentPolicy.Provider value={{ workspaceId, allowedAgents }}>
    <MarkdownSessionContext.Provider value={active?.id}>
    <ViewerContext.Provider value={viewerApi}>
    <MotionConfig reducedMotion="user">
      <div style={{ "--terminal-height": `${terminalHeight}px` } as React.CSSProperties} className={`app-shell ${railHidden ? "sidebar-collapsed" : "sidebar-expanded"}${isTauri() ? " tauri-app" : ""} desk-${desktopMode}${chatCollapsed && desktopMode !== "max" ? " chat-collapsed" : ""}`}>
        <WindowHeader title={tab === "tools" ? t("tools.title") : active?.title} workspaceId={workspaceId} onSwitchWorkspace={onSwitchWorkspace} otherRunning={otherRunning} onTools={() => setTab("tools")} toolsActive={tab === "tools"} onTerminal={() => toggleTerminal()} notifications={<NotificationsCenter workspaceId={workspaceId} cwd={shownCwd} connected={connected} onSession={selectConversation} onRefreshAuth={() => { void refreshModels(); }} />} />
        <TerminalPanel storageKey={workspaceId} cwd={shownCwd} homeCwd={boot.homeCwd} onHeightChange={setTerminalHeight} />
        {railHidden && <button type="button" className="sidebar-handle" aria-label={t("sidebar.expand")} title={t("ws.sidebarExpandTitle")} onClick={expandSidebar}><ChevronRight size={14} aria-hidden /></button>}
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
            replaceFromServer(updated);
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
          {lastAnnouncement}
        </div>
        <BrowserDesktop onAttach={addAttachments} request={desktopRequest} onModeChange={setDesktopMode} />
        {chatCollapsed && desktopMode !== "max" && <aside className="chat-rail" aria-label={t("ws.collapsedChat")}>
          <button type="button" onClick={() => setChatCollapsed(false)} aria-label={t("ws.expandChat")} title={t("ws.expandChat")}><PanelRightOpen size={18} /><MessageSquare size={18} /><span>{t("ws.chat")}</span></button>
        </aside>}
        {desktopMode === "max" && !chatWidgetOpen && <button type="button" className="chat-bubble" onClick={() => setChatWidgetOpen(true)} aria-label={t("ws.openChat")} title={t("ws.openChat")}>
          <MessageSquare size={22} />{active?.status === "running" && <span className="chat-bubble-dot" />}
        </button>}
        <main className={`${tab === "workspace" ? "chat-view" : "management-view"}${desktopMode === "max" ? (chatWidgetOpen ? " chat-float" : " chat-hidden") : ""}`}>
          {desktopMode === "max" && chatWidgetOpen && <button type="button" className="chat-float-close" onClick={() => setChatWidgetOpen(false)} aria-label={t("ws.collapseChat")} title={t("ws.collapseChat")}><ChevronDown size={16} /></button>}
          {tab === "routing" && <section className="glass routing-settings"><AppearanceSettings /></section>}
          {tab === "routing" && <AllowedAgentsSettings workspaceId={workspaceId} allowedAgents={allowedAgents} busy={busy}
            quotaFallback={quotaFallback} setQuotaFallback={setQuotaFallback} quotaThreshold={quotaThreshold} setQuotaThreshold={setQuotaThreshold}
            fallbackOrder={fallbackOrder} setFallbackOrder={setFallbackOrder}
            onAllowedChange={(next) => {
              setAllowedAgents(next);
              const team = workspaceTeamDefaults(workspaceId, { agent, workers, model, reasoningEffort, workerConfigs, allowedAgents: next });
              setAgent(team.agent); setWorkers(team.workers); setModel(team.model ?? ""); setReasoningEffort(team.reasoningEffort ?? "");
              setWorkerConfigs(normalizeWorkerConfigs(team.workers, team.workerConfigs));
              setRecommendation(undefined);
            }} />}
          {tab === "routing" && (routingSettings ? <RoutingSettingsPage value={routingSettings} busy={busy} onSave={async (next) => {
            setBusy(true); setError("");
            try { setRoutingSettings(await api<RoutingSettings>("/settings", next, "PUT")); }
            finally { setBusy(false); }
          }} onRefresh={async () => {
            const next = await api<RoutingSettings>("/settings/models/refresh", {}, "POST");
            setRoutingSettings(next);
            setRecommendation(undefined);
            return next;
          }} /> : <section className="glass routing-settings"><p>{t("ws.settingsLoadFailed")}</p><button className="button light" onClick={() => void load()}>{t("ws.reload")}</button></section>)}
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
                  {dragging && <div className="drop-overlay"><strong>{t("ws.dropHere")}</strong><span>{t("ws.dropKinds")}</span></div>}
                  <div className="panel-header">
                    <div>
                      <MessageSquare size={17} />
                      <h2>{selectedWorker ? t("ws.workerSession") : t("ws.conversation")}</h2>
                      <span className="subtle-tag">
                        {(active || mode === "manual") && <AgentMark agent={selectedWorker?.agent ?? active?.agent ?? agent} size="small" />}{selectedWorker ? selectedWorker.label : active ? names[active.agent] : mode === "auto" ? t("ws.autoAssign") : names[agent]}{(selectedWorker || active || mode === "manual") && <RemainingChip agent={selectedWorker?.agent ?? active?.agent ?? agent} />}
                      </span>
                    </div>
                    <div className="chat-actions">
                      {selectedWorker && active && <button className="button light" onClick={() => selectConversation(active.id)}>{t("ws.backToConversation")}</button>}
                      {active?.status === "running" && <button className="button light" disabled={busy} onClick={() => stopSession(active.id)}><Square size={12} />{t("ws.stop")}</button>}
                      <button className="icon-button" aria-label={t("ws.browser")} title={t("ws.browserTitle")} onClick={() => showBrowser(false)}><Globe size={18} /></button>
                      {desktopMode !== "max" && <button className="icon-button" aria-label={t("ws.collapseChat")} title={t("ws.collapseChat")} onClick={() => setChatCollapsed(true)}><PanelRightClose size={18} /></button>}
                      <button className="icon-button" aria-label={t("activity.label")} aria-expanded={activityOpen} aria-controls="activity-panel" onClick={() => setActivityOpen((value) => !value)}><Activity size={18} /></button>
                    </div>
                  </div>
                  <TeamBarSlot key={active?.id ?? "new"} workspaceId={workspaceId} active={active} pendingRecommendation={pendingRecommendation} mode={mode}
                    manual={{ agent, model, reasoningEffort, workers, workerConfigs }} availableAgents={teamAgents}
                    quotaFallback={quotaFallback} quotaThreshold={quotaThreshold} routingSettings={routingSettings} busy={busy}
                    onSave={(next, crew) => safe(async () => {
                      if (active) {
                        replaceFromServer(await api<Session>(`/sessions/${active.id}/team`, { ...next, workers: crew.map((worker) => worker.agent), workerConfigs: crew }, "PATCH"));
                      } else if (pendingRecommendation) {
                        setRecommendation({ key: routingKey, value: { ...pendingRecommendation, orchestrator: next, workers: crew } });
                      } else {
                        setAgent(next.agent); setModel(next.model ?? ""); setReasoningEffort(next.reasoningEffort ?? "");
                        setWorkers(crew.map((worker) => worker.agent)); setWorkerConfigs(crew); setMode("manual");
                      }
                    })} />
                  {active && active.status !== "running" && <QuotaReturnBanner active={active} threshold={quotaThreshold} allowedAgents={allowedAgents} busy={busy}
                    onReturn={(eventId) => void sessionAction(`/sessions/${active.id}/quota/return`, { eventId })} />}
                  <div ref={chatBody} className={`chat-body ${!active && !pendingRecommendation ? "empty-chat" : ""}`} onScroll={onChatScroll}>
                    {selectedWorker ? <><WorkerThread key={`${active?.id}-${selectedWorker.id}`} worker={selectedWorker} /><div ref={bottom} /></> : !active ? (
                      pendingRecommendation ? <div className="messages routing-message">
                        <div className="message user-message"><div className="message-author"><strong>{t("names.user")}</strong></div><div className="message-text">{prompt}</div></div>
                        <RecommendationCard value={pendingRecommendation} settings={routingSettings} skills={boot.skills} editing={editingRecommendation} busy={busy} runDisabled={!canSend || Boolean(unavailableWarning)} availableAgents={teamAgents} onEdit={() => setEditingRecommendation((old) => !old)} onChange={(value) => setRecommendation({ key: routingKey, value })} onRun={() => void send(true)} />
                        <div ref={bottom} />
                      </div> : <div className="minimal-empty">
                        <h2>{t("ws.emptyTitle")}</h2>
                        <div className="prompt-chips">
                          {promptChips().map(([label, text]) => <button key={label} onClick={() => { setPrompt(text); composerInput.current?.focus(); }}>{label}</button>)}
                        </div>
                      </div>
                    ) : (
                      <MessageList active={active} events={conversationEvents} tasksById={tasksById} latestHandoffId={latestHandoffId} latestAssistantId={latestAssistant?.id}
                        choiceOptions={choiceOptions} streamingMessageId={streamingMessageId} busy={busy} bottomRef={bottom}
                        onUndoHandoff={(eventId) => void sessionAction(`/sessions/${active.id}/handoff/undo`, { eventId })}
                        onOpenWorker={(workerId) => { selectWorker(active.id, workerId); expandSidebar(); }}
                        onPromote={promoteLiveMessage}
                        onChoose={(option) => void send(false, option)} />
                    )}
                  </div>
                  {showChatBottom && !selectedWorker && <button type="button" className="chat-bottom-button" onClick={() => scrollToChatBottom()}><ArrowDown size={15} />{t("ws.toBottom")}</button>}
                  {!selectedWorker && <Composer completion={completion} attachments={attachmentState} prompt={prompt} setPrompt={setPrompt}
                    skills={skills} messageSkills={messageSkills} setMessageSkills={setMessageSkills} availableSkills={boot.skills}
                    active={active} sessionRunning={sessionRunning} busy={busy} routing={routing} liveNote={liveNote} chatError={chatError} unavailableWarning={unavailableWarning}
                    mode={mode} setMode={setMode} agent={agent} cwd={cwd} shownCwd={shownCwd} canSend={canSend} choiceOptions={choiceOptions}
                    send={send} stopActive={stopActive} openModal={setModal} openViewer={openViewer} />}
                </section>
                {activityOpen && <ActivityPanel active={active} connected={connected} rows={activityEvents} onClose={() => setActivityOpen(false)} />}
              </div>
            </>
          )}
          {tab === "sessions" && <SessionsView sessions={sessions} onNew={newSession} onSelect={selectConversation} onStop={stopSession} />}
          {tab === "bots" && <BotsView bots={boot.bots} botA={botA} setBotA={setBotA} botB={botB} setBotB={setBotB} turns={turns} setTurns={setTurns}
            prompt={prompt} setPrompt={setPrompt} cwd={cwd} busy={busy} connected={connected}
            onCreate={() => setModal("bot")} onPickFolder={() => setModal("directory")}
            onUse={(b: Preset) => {
              setMode("manual");
              chooseAgent(b.agent);
              setModel(b.model ?? "");
              setSkills(b.skills);
              setSystemPrompt(b.systemPrompt);
              newSession();
            }}
            onDelete={(b: Preset) => void safe(async () => {
              await api(`/bots/${b.id}`, undefined, "DELETE");
              await load();
            })}
            onStart={() => void safe(async () => {
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
            })} />}
        </main>
        {modal && <AppModal modal={modal} setModal={setModal} workspaceId={workspaceId} error={error} clearError={() => setError("")} busy={busy}
          agents={boot.agents} availableSkills={boot.skills} skills={skills} setSkills={setSkills} search={search} setSearch={setSearch}
          skillReturn={skillReturn} setSkillReturn={setSkillReturn} shownCwd={shownCwd} cwd={cwd}
          onUseFolder={(path) => { setCwd(path); setModal(undefined); }}
          botName={botName} setBotName={setBotName} agent={agent} chooseAgent={chooseAgent} allowedAgents={allowedAgents}
          model={model} reasoningEffort={reasoningEffort} onModelChange={(nextModel, nextEffort) => { setModel(nextModel); setReasoningEffort(nextEffort); }}
          routingSettings={routingSettings} autoSwitch={autoSwitch} setAutoSwitch={setAutoSwitch} systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt}
          onOpenRouting={() => { setModal(undefined); setTab("routing"); }}
          onRefreshSkills={() => void safe(async () => {
            const next = await api<Skill[]>("/skills/refresh", { cwd: shownCwd, workspace: workspaceId });
            setBoot((old) => ({ ...old, skills: next }));
          })}
          onSaveBot={() => void safe(async () => {
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
          })} />}
      </div>
    </MotionConfig>
    {viewer && <FileViewer items={viewer.items} index={viewer.index} onIndex={(index) => setViewer({ items: viewer.items, index })} onClose={() => setViewer(null)} />}
    </ViewerContext.Provider>
    </MarkdownSessionContext.Provider>
    </WorkspaceAgentPolicy.Provider>
  );
}
