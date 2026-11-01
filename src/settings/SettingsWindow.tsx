// The settings window (⌘,): category sidebar + content, one search box over every setting.
// Opened by WorkspaceApp; categories render through `renderPage`.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, BarChart3, Bell, Bot, ChevronDown, CircleHelp, FolderKanban, Keyboard, Layers, Palette, RefreshCcw, Route, Search, Settings2, ShieldCheck, Wrench, X } from "lucide-react";
import { ContextMenu, type MenuItem } from "../SidebarMenu";
import { useWorkspaces } from "../workspace-context";
import { workspaceName } from "../workspaces";
import { useAppUpdate } from "../updates/useAppUpdate";
import { t } from "../i18n";
import { SaveIndicator, SaveProvider } from "./controls";
import { APP_CATEGORIES, CATEGORIES, categoryLabel, searchSettings, stepCategory, WORKSPACE_CATEGORIES, type SettingEntry, type SettingsCategory } from "./settings-nav";
import "./settings.css";

export const SETTINGS_REOPEN_KEY = "sinawi:settings:reopen";

const icons: Record<SettingsCategory, ReactNode> = {
  general: <Settings2 size={16} />, appearance: <Palette size={16} />, notifications: <Bell size={16} />, shortcuts: <Keyboard size={16} />,
  environment: <ShieldCheck size={16} />, updates: <RefreshCcw size={16} />, workspaces: <Layers size={16} />, agents: <Bot size={16} />,
  routing: <Route size={16} />, projects: <FolderKanban size={16} />,
};

function useServerVersion() {
  const { state } = useAppUpdate();
  const [server, setServer] = useState("");
  useEffect(() => {
    if (state.currentVersion) return;
    let cancelled = false;
    void fetch("/api/health", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).then((body) => { if (!cancelled && typeof body?.version === "string") setServer(body.version); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [state.currentVersion]);
  return state.currentVersion || server;
}

export function SettingsWindow({ section, focus, onSection, onClose, renderPage, onOpenTools, onOpenUsage }: {
  section: SettingsCategory; focus?: string; onSection: (id: SettingsCategory) => void; onClose: () => void;
  renderPage: (id: SettingsCategory, close: () => void) => ReactNode; onOpenTools: () => void; onOpenUsage: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [highlight, setHighlight] = useState<string | undefined>(focus);
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number }>();
  const { workspaces, currentId, switchTo } = useWorkspaces();
  const version = useServerVersion();
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 120); return () => window.clearTimeout(timer); }, [query]);
  const results = useMemo(() => searchSettings(debounced), [debounced]);
  const searching = debounced.trim().length > 0;

  // Focus moves in on open and back to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => (navRef.current?.querySelector<HTMLElement>("[aria-current=page]") ?? searchRef.current)?.focus());
    return () => { previous?.focus?.(); };
  }, []);
  useEffect(() => { if (focus) setHighlight(focus); }, [focus]);
  // Escape still closes when focus fell outside the window (e.g. onto <body> after a click on empty space).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target as Node | null;
      if (target && dialog.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".modal, .settings-confirm, .ctx-menu, .glass-select-menu")) return;
      if (document.querySelector(".modal, .settings-confirm")) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Scroll to and flash the setting a search result (or a deep link) pointed at.
  useLayoutEffect(() => {
    if (!highlight || searching) return;
    const target = contentRef.current?.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(highlight)}"]`);
    if (!target) { contentRef.current?.scrollTo({ top: 0 }); return; }
    target.scrollIntoView({ block: "center" });
    (target.querySelector<HTMLElement>("[role=switch], [role=radio][tabindex='0'], input:not([type=hidden]), button:not(.setting-reset), textarea") ?? contentRef.current)?.focus({ preventScroll: true });
    target.classList.add("flash");
    const timer = window.setTimeout(() => { target.classList.remove("flash"); setHighlight(undefined); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [highlight, section, searching]);
  useEffect(() => { if (!highlight) contentRef.current?.scrollTo({ top: 0 }); }, [section]);

  const go = (id: SettingsCategory, focusNav = false) => {
    onSection(id);
    if (focusNav) requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-category="${id}"]`)?.focus());
  };
  const openResult = (entry: SettingEntry) => { setQuery(""); setDebounced(""); onSection(entry.category); setHighlight(entry.id); };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (query) { setQuery(""); setDebounced(""); searchRef.current?.focus(); return; }
      onClose();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
    if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const id = CATEGORIES[Number(event.key) - 1];
      if (id) { event.preventDefault(); event.stopPropagation(); setQuery(""); setDebounced(""); go(id); }
      return;
    }
    if (event.key === "Tab") {
      // Focus trap: Tab cycles inside the window.
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex]:not([tabindex='-1'])") ?? [])].filter((node) => node.offsetParent !== null || node === document.activeElement);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  const onNavKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? CATEGORIES[0] : event.key === "End" ? CATEGORIES[CATEGORIES.length - 1] : stepCategory(section, event.key === "ArrowDown" ? 1 : -1);
    setQuery(""); setDebounced("");
    go(next, true);
  };

  const currentName = workspaceName(workspaces, currentId ?? "");
  const spaceItems: MenuItem[] = workspaces.map((workspace) => ({
    kind: "action", label: workspaceName(workspaces, workspace.id), checked: workspace.id === currentId,
    onSelect: () => {
      if (workspace.id === currentId) return;
      try { sessionStorage.setItem(SETTINGS_REOPEN_KEY, section); } catch { /* optional */ }
      switchTo(workspace.id);
    },
  }));
  const navItem = (id: SettingsCategory) => <li key={id}>
    <button type="button" data-category={id} className="settings-nav-item" aria-current={!searching && section === id ? "page" : undefined}
      tabIndex={section === id ? 0 : -1} onClick={() => { setQuery(""); setDebounced(""); go(id); }}>
      <span className="settings-nav-icon" aria-hidden="true">{icons[id]}</span><span title={categoryLabel(id)}>{categoryLabel(id)}</span>
    </button>
  </li>;
  const workspaceScoped = (WORKSPACE_CATEGORIES as readonly string[]).includes(section);

  return <div className="modal-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <SaveProvider>
      <section ref={dialog} className="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
        <aside className="settings-sidebar">
          <div className="settings-sidebar-search settings-search-field">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} type="search" value={query} placeholder={t("set.search.placeholder")} aria-label={t("set.search.label")} aria-controls="settings-content"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && results[0]) { event.preventDefault(); openResult(results[0]); } if (event.key === "ArrowDown" && results.length) { event.preventDefault(); contentRef.current?.querySelector<HTMLElement>(".settings-result")?.focus(); } }} />
            {!query && <kbd aria-hidden="true">⌘F</kbd>}
          </div>
          <nav ref={navRef} className="settings-nav" aria-label={t("set.nav.label")} onKeyDown={onNavKey}>
            <h2 className="settings-nav-group">{t("set.nav.app")}</h2>
            <ul>{APP_CATEGORIES.map(navItem)}</ul>
            <div className="settings-nav-group settings-nav-space">
              <h2>{t("set.nav.workspace")}</h2>
              {workspaces.length > 1 ? <button type="button" className="settings-space-chip" aria-haspopup="menu" aria-expanded={Boolean(spaceMenu)} aria-label={t("set.nav.switchSpace", { name: currentName })}
                onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setSpaceMenu(spaceMenu ? undefined : { x: box.left, y: box.bottom + 4 }); }}>
                <span>{currentName}</span><ChevronDown size={12} aria-hidden="true" /></button>
                : <span className="settings-space-chip static">{currentName}</span>}
            </div>
            <ul>{WORKSPACE_CATEGORIES.map(navItem)}</ul>
            <h2 className="settings-nav-group">{t("set.nav.pages")}</h2>
            <ul>
              <li><button type="button" className="settings-nav-item link" onClick={onOpenTools}><span className="settings-nav-icon" aria-hidden="true"><Wrench size={16} /></span><span>{t("tools.title")}</span><ArrowUpRight size={13} className="settings-nav-arrow" aria-hidden="true" /></button></li>
              <li><button type="button" className="settings-nav-item link" onClick={onOpenUsage}><span className="settings-nav-icon" aria-hidden="true"><BarChart3 size={16} /></span><span>{t("side.usage")}</span><ArrowUpRight size={13} className="settings-nav-arrow" aria-hidden="true" /></button></li>
            </ul>
          </nav>
          <footer className="settings-sidebar-foot">
            <button type="button" className="settings-foot-link" onClick={() => { setQuery(""); go("environment"); setHighlight("env-onboarding"); }}><CircleHelp size={14} aria-hidden="true" />{t("set.nav.help")}</button>
            {version && <small>Sinawi {version}</small>}
          </footer>
        </aside>
        <div className="settings-main">
          <header className="settings-topbar">
            <div className="settings-title">
              <h1 id="settings-title">{searching ? t("set.search.results") : categoryLabel(section)}</h1>
              {workspaceScoped && !searching && <span className="settings-scope">{t("set.scope", { space: currentName })}</span>}
            </div>
            <SaveIndicator />
            <button type="button" className="settings-close" aria-label={t("set.close")} title={`${t("set.close")} (Esc)`} onClick={onClose}><X size={16} /></button>
          </header>
          <label className="settings-mobile-nav">
            <span className="sr-only">{t("set.nav.label")}</span>
            <select value={section} onChange={(event) => { setQuery(""); go(event.target.value as SettingsCategory); }}>
              <optgroup label={t("set.nav.app")}>{APP_CATEGORIES.map((id) => <option key={id} value={id}>{categoryLabel(id)}</option>)}</optgroup>
              <optgroup label={t("set.nav.workspace")}>{WORKSPACE_CATEGORIES.map((id) => <option key={id} value={id}>{categoryLabel(id)}</option>)}</optgroup>
            </select>
          </label>
          <div ref={contentRef} id="settings-content" className="settings-content" tabIndex={-1}>
            {searching ? <div className="settings-page" aria-live="polite">
              <p className="sr-only" role="status">{t("set.search.count", { n: results.length })}</p>
              {results.length ? <ul className="settings-results">{results.map((entry) => <li key={entry.id}>
                <button type="button" className="settings-result" onClick={() => openResult(entry)}
                  onKeyDown={(event) => {
                    const items = [...(contentRef.current?.querySelectorAll<HTMLElement>(".settings-result") ?? [])];
                    const index = items.indexOf(event.currentTarget);
                    if (event.key === "ArrowDown") { event.preventDefault(); items[index + 1]?.focus(); }
                    if (event.key === "ArrowUp") { event.preventDefault(); (items[index - 1] ?? searchRef.current)?.focus(); }
                  }}>
                  <span className="settings-result-path">{categoryLabel(entry.category)} › {t(entry.section)}</span>
                  <strong>{t(entry.label)}</strong>
                  {entry.description && <small>{t(entry.description)}</small>}
                </button>
              </li>)}</ul> : <p className="settings-empty-line">{t("set.search.none", { query: debounced.trim() })}</p>}
            </div> : renderPage(section, onClose)}
          </div>
        </div>
      </section>
    </SaveProvider>
    {spaceMenu && <ContextMenu x={spaceMenu.x} y={spaceMenu.y} label={t("workspace.menu")} items={spaceItems} onClose={() => setSpaceMenu(undefined)} />}
  </div>;
}
