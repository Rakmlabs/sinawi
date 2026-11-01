// Workspace-scoped settings pages: Agents (allowed agents + switching), Routing, Projects.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, FolderOpen, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { RemainingChip } from "../QuotaContext";
import { ModelChoice } from "../RoutingControls";
import { names } from "../app/labels";
import { t } from "../i18n";
import type { AgentId, Group } from "../../server/types";
import type { RoutingRule, RoutingSettings } from "../../server/routing";
import { ConfirmDialog, EmptyState, SettingRow, SettingsPage, SettingsSection, StatusBadge, SwitchRow, useCommitted, useSaveStatus } from "./controls";
import { openSettings } from "./settings-nav";

const AGENTS: AgentId[] = ["codex", "claude", "grok"];
const fallbackCandidates = (source: AgentId): AgentId[] => source === "codex" ? ["claude", "grok"] : source === "claude" ? ["codex", "grok"] : ["claude", "codex"];
const clampThreshold = (value: number) => Math.max(0, Math.min(100, Math.round(value * 2) / 2));

export type AgentsPageProps = {
  agents: { id: string; available: boolean }[];
  routingSettings: RoutingSettings | undefined;
  allowedAgents: AgentId[];
  onAllowedChange: (next: AgentId[]) => void;
  quotaFallback: boolean; setQuotaFallback: (value: boolean) => void;
  quotaThreshold: number; setQuotaThreshold: (value: number) => void;
  fallbackOrder: Partial<Record<AgentId, AgentId[]>>;
  setFallbackOrder: (update: (old: Partial<Record<AgentId, AgentId[]>>) => Partial<Record<AgentId, AgentId[]>>) => void;
  autoSwitch: boolean; setAutoSwitch: (value: boolean) => void;
};

/** Settings › Agents: which agents this workspace may use, and both kinds of automatic switching. */
export function AgentsPage(props: AgentsPageProps) {
  const { agents, routingSettings, allowedAgents, onAllowedChange, quotaFallback, setQuotaFallback, quotaThreshold, setQuotaThreshold, fallbackOrder, setFallbackOrder, autoSwitch, setAutoSwitch } = props;
  const { track } = useSaveStatus();
  const [threshold, setThreshold] = useState(String(quotaThreshold));
  useEffect(() => setThreshold(String(quotaThreshold)), [quotaThreshold]);
  const parsed = Number(threshold);
  const thresholdInvalid = threshold.trim() === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > 100;
  const commitThreshold = (raw: string) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) return;
    const next = clampThreshold(value);
    setThreshold(String(next));
    if (next !== quotaThreshold) void track(async () => setQuotaThreshold(next));
  };
  const sources = allowedAgents.filter((source) => fallbackCandidates(source).some((id) => allowedAgents.includes(id)));
  return <SettingsPage>
    <SettingsSection title={t("set.agents.allowed")} description={t("set.agents.allowedDesc")}>
      {AGENTS.map((id) => {
        const info = agents.find((agent) => agent.id === id);
        const authStatus = routingSettings?.modelOptions[id]?.authStatus;
        return <SwitchRow key={id} id={id === AGENTS[0] ? "allowed" : `allowed-${id}`} icon={<AgentMark agent={id} size="small" />} label={names[id]}
          badges={<>{info && !info.available ? <StatusBadge tone="muted">{t("ob.notInstalled")}</StatusBadge> : authStatus === "unauthenticated" ? <StatusBadge tone="warn">{t("ob.loginRequired")}</StatusBadge> : null}<RemainingChip agent={id} /></>}
          description={info && !info.available ? t("set.agents.notInstalledDesc") : authStatus === "unauthenticated" ? routingSettings?.modelOptions[id]?.authDetail : undefined}
          value={allowedAgents.includes(id)}
          save={(on) => onAllowedChange(on ? AGENTS.filter((agent) => agent === id || allowedAgents.includes(agent)) : allowedAgents.filter((agent) => agent !== id))} />;
      })}
      {!allowedAgents.length && <p className="settings-banner warn in-card" role="status">{t("allowed.needOne")}</p>}
    </SettingsSection>

    <SettingsSection title={t("set.agents.switching")} description={t("set.agents.switchingDesc")}>
      <SwitchRow id="quotaFallback" label={t("allowed.autoSwitch")} description={t("set.agents.quotaDesc")} value={quotaFallback} save={setQuotaFallback} />
      <div className={`settings-collapse${quotaFallback ? " open" : ""}`} aria-hidden={!quotaFallback}>
        <div>
          <SettingRow id="quotaThreshold" label={t("set.agents.threshold")} description={t("set.agents.thresholdDesc")} disabled={!quotaFallback}
            error={thresholdInvalid ? t("set.agents.thresholdRange") : undefined}>
            {({ controlId, descId }) => <div className="settings-range">
              <input type="range" min={0} max={100} step={0.5} value={thresholdInvalid ? quotaThreshold : parsed} disabled={!quotaFallback} aria-label={t("set.agents.threshold")} aria-describedby={descId}
                onChange={(event) => setThreshold(event.target.value)}
                onPointerUp={(event) => commitThreshold(event.currentTarget.value)} onKeyUp={(event) => commitThreshold(event.currentTarget.value)} onBlur={(event) => commitThreshold(event.currentTarget.value)} />
              <span className="settings-number">
                <input id={controlId} type="number" min={0} max={100} step={0.5} value={threshold} disabled={!quotaFallback} aria-invalid={thresholdInvalid} aria-describedby={descId}
                  onChange={(event) => setThreshold(event.target.value)} onBlur={(event) => commitThreshold(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) commitThreshold(event.currentTarget.value); }} />
                <span aria-hidden="true">%</span>
              </span>
            </div>}
          </SettingRow>
          <SettingRow id="fallbackOrder" label={t("set.agents.order")} description={t("allowed.order")} block disabled={!quotaFallback}>
            {sources.length ? <div className="settings-order">{sources.map((source) => {
              const candidates = fallbackCandidates(source).filter((id) => allowedAgents.includes(id));
              const first = fallbackOrder[source]?.find((id) => candidates.includes(id)) ?? candidates[0];
              return <div key={source} className="settings-order-row">
                <span className="settings-order-from"><AgentMark agent={source} size="small" />{t("set.agents.after", { agent: names[source] })}</span>
                {candidates.length > 1 ? <GlassSelect className="settings-select" label={t("allowed.priority", { agent: names[source] })} value={first} disabled={!quotaFallback}
                  onChange={(value) => { void track(async () => setFallbackOrder((old) => ({ ...old, [source]: [value as AgentId, ...candidates.filter((id) => id !== value)] }))); }}
                  options={candidates.map((id) => ({ value: id, label: names[id], icon: <AgentMark agent={id} size="small" /> }))} />
                  : <span className="settings-order-only"><AgentMark agent={candidates[0]} size="small" />{names[candidates[0]]}</span>}
              </div>;
            })}</div> : <p className="settings-empty-line">{t("set.agents.noOthers")}</p>}
          </SettingRow>
        </div>
      </div>
      <SwitchRow id="autoSwitch" label={t("modal.autoSwitch")} description={t("modal.autoSwitchHint")} value={autoSwitch} save={setAutoSwitch} />
    </SettingsSection>
  </SettingsPage>;
}

/* — Routing — */

function jsonError(text: string): string | undefined {
  try { JSON.parse(text); return undefined; } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const position = Number(/position (\d+)/.exec(message)?.[1]);
    const line = Number(/line (\d+)/.exec(message)?.[1]) || (Number.isFinite(position) ? text.slice(0, position).split("\n").length : 0);
    return line ? t("set.routing.jsonErrorLine", { line }) : t("set.routing.jsonError");
  }
}

function useDebounced<V>(value: V, ms: number): V {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(timer); }, [value, ms]);
  return debounced;
}

const keywordsText = (rule: RoutingRule) => rule.keywords.join(", ");
const parseKeywords = (text: string) => [...new Set(text.split(/[,\n]/).map((word) => word.trim()).filter(Boolean))];

function RuleEditor({ rule, index, count, onChange, onMove, onDelete }: { rule: RoutingRule; index: number; count: number; onChange: (next: RoutingRule) => void; onMove: (delta: number) => void; onDelete: () => void }) {
  const [label, setLabel] = useState(rule.label);
  const [keywords, setKeywords] = useState(keywordsText(rule));
  const [reason, setReason] = useState(rule.reason);
  useEffect(() => { setLabel(rule.label); setKeywords(keywordsText(rule)); setReason(rule.reason); }, [rule]);
  const commit = (patch: Partial<RoutingRule>) => onChange({ ...rule, ...patch });
  const textKeys = (save: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } };
  const saveLabel = () => { if (label.trim() && label.trim() !== rule.label) commit({ label: label.trim() }); else setLabel(rule.label); };
  const saveKeywords = () => { const next = parseKeywords(keywords); if (next.length && next.join("\n") !== rule.keywords.join("\n")) commit({ keywords: next }); else setKeywords(keywordsText(rule)); };
  const saveReason = () => { if (reason.trim() && reason.trim() !== rule.reason) commit({ reason: reason.trim() }); else setReason(rule.reason); };
  return <li className="settings-rule">
    <div className="settings-rule-head">
      <span className="settings-rule-index" aria-hidden="true">{index + 1}</span>
      <input className="settings-input settings-rule-name" aria-label={t("set.routing.ruleName", { n: index + 1 })} value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} onBlur={saveLabel} onKeyDown={textKeys(saveLabel)} />
      <span className="settings-spacer" />
      <button type="button" className="settings-icon" aria-label={t("set.routing.moveUp", { name: rule.label })} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
      <button type="button" className="settings-icon" aria-label={t("set.routing.moveDown", { name: rule.label })} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown size={14} /></button>
      <button type="button" className="settings-icon danger" aria-label={t("set.routing.deleteRule", { name: rule.label })} onClick={onDelete}><Trash2 size={14} /></button>
    </div>
    <div className="settings-rule-grid">
      <label className="settings-rule-field wide"><span>{t("set.routing.keywords")}</span>
        <input className="settings-input" value={keywords} placeholder={t("set.routing.keywordsPlaceholder")} onChange={(event) => setKeywords(event.target.value)} onBlur={saveKeywords} onKeyDown={textKeys(saveKeywords)} /></label>
      <div className="settings-rule-field"><span id={`rule-${rule.id}-lead`}>{t("rt.lead")}</span>
        <GlassSelect className="settings-select compact" label={t("set.routing.leadFor", { name: rule.label })} value={rule.orchestrator}
          onChange={(value) => commit({ orchestrator: value as AgentId })} options={AGENTS.map((id) => ({ value: id, label: names[id], icon: <AgentMark agent={id} size="small" /> }))} /></div>
      <div className="settings-rule-field"><span id={`rule-${rule.id}-workers`}>{t("set.routing.workers")}</span>
        <div className="settings-chips" role="group" aria-labelledby={`rule-${rule.id}-workers`}>
          {AGENTS.map((id) => { const on = rule.workers.includes(id); return <button key={id} type="button" className={`settings-chip${on ? " on" : ""}`} aria-pressed={on}
            disabled={on && rule.workers.length === 1} title={on && rule.workers.length === 1 ? t("set.routing.needWorker") : undefined}
            onClick={() => commit({ workers: on ? rule.workers.filter((item) => item !== id) : AGENTS.filter((agent) => agent === id || rule.workers.includes(agent)) })}>
            <AgentMark agent={id} size="small" />{names[id]}</button>; })}
        </div></div>
      <label className="settings-rule-field wide"><span>{t("set.routing.reason")}</span>
        <input className="settings-input" value={reason} onChange={(event) => setReason(event.target.value)} onBlur={saveReason} onKeyDown={textKeys(saveReason)} /></label>
    </div>
  </li>;
}

export function RoutingPage({ value, onSave, onRefresh, onReload }: { value: RoutingSettings | undefined; onSave: (next: RoutingSettings) => Promise<void>; onRefresh: () => Promise<RoutingSettings>; onReload: () => void }) {
  const { track } = useSaveStatus();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "done" | "error">("idle");
  const [rules, setRules] = useState(value?.rules ?? []);
  const [rulesError, setRulesError] = useState<{ retry: () => void }>();
  const [deleting, setDeleting] = useState<RoutingRule>();
  const [rulesJson, setRulesJson] = useState(() => JSON.stringify(value?.rules ?? [], null, 2));
  const [modelsJson, setModelsJson] = useState(() => JSON.stringify(value?.modelOptions ?? {}, null, 2));
  const [advancedError, setAdvancedError] = useState("");
  const [applying, setApplying] = useState(false);
  const savedRulesJson = JSON.stringify(value?.rules ?? [], null, 2);
  const savedModelsJson = JSON.stringify(value?.modelOptions ?? {}, null, 2);
  const lastSaved = useRef({ rules: savedRulesJson, models: savedModelsJson });
  useEffect(() => {
    setRules(value?.rules ?? []);
    // Keep the JSON drafts in step with saved changes, unless the user is editing them.
    setRulesJson((draft) => draft === lastSaved.current.rules ? savedRulesJson : draft);
    setModelsJson((draft) => draft === lastSaved.current.models ? savedModelsJson : draft);
    lastSaved.current = { rules: savedRulesJson, models: savedModelsJson };
  }, [value]);
  const debouncedRules = useDebounced(rulesJson, 300);
  const debouncedModels = useDebounced(modelsJson, 300);
  const rulesSyntax = useMemo(() => jsonError(debouncedRules), [debouncedRules]);
  const modelsSyntax = useMemo(() => jsonError(debouncedModels), [debouncedModels]);
  const [planner, commitPlanner, plannerError] = useCommitted(value?.planner ?? { agent: "claude" as AgentId }, async (next) => { if (value) await onSave({ ...value, planner: next }); });
  if (!value) return <SettingsPage>
    <EmptyState title={t("ws.settingsLoadFailed")} action={<button type="button" className="settings-button" onClick={onReload}>{t("ws.reload")}</button>} />
  </SettingsPage>;

  const saveRules = (next: RoutingRule[]) => {
    const previous = rules;
    setRules(next);
    setRulesError(undefined);
    void track(() => onSave({ ...value, rules: next })).catch(() => { setRules(previous); setRulesError({ retry: () => saveRules(next) }); });
  };
  const refresh = () => {
    setRefreshing(true); setRefreshState("idle");
    void onRefresh().then(() => setRefreshState("done"), () => setRefreshState("error")).finally(() => setRefreshing(false));
  };
  const dirty = rulesJson !== savedRulesJson || modelsJson !== savedModelsJson;
  const valid = !jsonError(rulesJson) && !jsonError(modelsJson);
  return <SettingsPage>
    <SettingsSection title={t("set.routing.planner")} description={t("set.routing.plannerDesc")}>
      <SettingRow id="planner" label={t("rt.analyzer")} block error={plannerError && t("set.save.rowFailed")} onRetry={plannerError?.retry}>
        <ModelChoice label={t("rt.analyzer")} value={planner} settings={value} onChange={(next) => commitPlanner({ agent: next.agent, model: next.model, reasoningEffort: next.reasoningEffort })} />
      </SettingRow>
    </SettingsSection>

    <SettingsSection title={t("set.routing.models")} description={t("set.routing.modelsDesc")}
      actions={<button type="button" className="settings-button" disabled={refreshing} onClick={refresh}><RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />{refreshing ? t("rt.checkingModels") : t("rt.refreshModels")}</button>}>
      {AGENTS.map((id) => {
        const option = value.modelOptions[id];
        return <SettingRow key={id} id={id === AGENTS[0] ? "models" : undefined} icon={<AgentMark agent={id} size="small" />} label={names[id]}
          description={<>{option?.source === "cli" ? t("rt.fromCli") : t("rt.preset")} · {t("set.routing.modelCount", { n: option?.models.length ?? 0 })}{option?.sourceDetail ? ` · ${option.sourceDetail}` : ""}</>}
          badges={option?.authStatus === "unauthenticated" ? <StatusBadge tone="warn">{t("ob.loginRequired")}</StatusBadge> : undefined}>
          {option?.authStatus === "unauthenticated" && <button type="button" className="settings-button" onClick={() => openSettings("environment", "env-login")}>{t("set.routing.signIn")}</button>}
        </SettingRow>;
      })}
      {refreshState !== "idle" && <p className={`settings-banner in-card${refreshState === "error" ? " danger" : ""}`} role={refreshState === "error" ? "alert" : "status"}>
        {refreshState === "done" ? t("set.routing.refreshed") : <>{t("set.routing.refreshFailed")} · <button type="button" className="settings-link" onClick={refresh}>{t("common.retry")}</button></>}</p>}
    </SettingsSection>

    <SettingsSection title={t("set.routing.rules")} description={t("set.routing.rulesDesc")}
      actions={<button type="button" className="settings-button" disabled={rules.length >= 50} onClick={() => saveRules([...rules, { id: `custom-${Date.now().toString(36)}`, label: t("set.routing.newRule"), keywords: [t("set.routing.newKeyword")], orchestrator: "claude", workers: ["codex"], reason: t("rt.addedManually") }])}><Plus size={14} aria-hidden="true" />{t("set.routing.addRule")}</button>}>
      <div data-setting-id="rules">
        {rules.length ? <ol className="settings-rules">{rules.map((rule, index) => <RuleEditor key={rule.id} rule={rule} index={index} count={rules.length}
          onChange={(next) => saveRules(rules.map((item) => item.id === rule.id ? next : item))}
          onMove={(delta) => { const next = [...rules]; const [moved] = next.splice(index, 1); next.splice(index + delta, 0, moved); saveRules(next); }}
          onDelete={() => setDeleting(rule)} />)}</ol>
          : <EmptyState title={t("set.routing.noRules")} body={t("set.routing.noRulesBody")} />}
        {rulesError && <p className="setting-row-error" role="alert">{t("set.save.rowFailed")} · <button type="button" className="settings-link" onClick={rulesError.retry}>{t("common.retry")}</button></p>}
      </div>
    </SettingsSection>

    <details className="settings-advanced" data-setting-id="advanced">
      <summary><span>{t("set.routing.advanced")}</span><small>{t("set.routing.advancedDesc")}</small></summary>
      <div className="settings-advanced-body">
        <label className="settings-json"><span>{t("rt.rules")}</span>
          <textarea rows={12} spellCheck={false} value={rulesJson} aria-invalid={Boolean(rulesSyntax)} onChange={(event) => setRulesJson(event.target.value)} />
          {rulesSyntax && <small className="settings-json-error" role="alert">{rulesSyntax}</small>}
        </label>
        <p className="settings-hint">{t("rt.rulesHint")}</p>
        <label className="settings-json"><span>{t("rt.models")}</span>
          <textarea rows={12} spellCheck={false} value={modelsJson} aria-invalid={Boolean(modelsSyntax)} onChange={(event) => setModelsJson(event.target.value)} />
          {modelsSyntax && <small className="settings-json-error" role="alert">{modelsSyntax}</small>}
        </label>
        {advancedError && <p className="settings-banner danger" role="alert">{advancedError}</p>}
        <div className="settings-advanced-actions">
          <button type="button" className="settings-button" disabled={!dirty || applying} onClick={() => { setRulesJson(savedRulesJson); setModelsJson(savedModelsJson); setAdvancedError(""); }}>{t("set.routing.revert")}</button>
          <button type="button" className="settings-button primary" disabled={!dirty || !valid || applying} onClick={() => {
            setApplying(true); setAdvancedError("");
            const next = { ...value, rules: JSON.parse(rulesJson), modelOptions: JSON.parse(modelsJson) };
            lastSaved.current = { rules: rulesJson, models: modelsJson };
            void track(() => onSave(next)).catch((cause) => setAdvancedError(cause instanceof Error ? cause.message : String(cause))).finally(() => setApplying(false));
          }}><Check size={14} aria-hidden="true" />{applying ? t("rt.saving") : t("set.routing.apply")}</button>
        </div>
      </div>
    </details>
    {deleting && <ConfirmDialog title={t("set.routing.deleteConfirm", { name: deleting.label })} body={t("set.routing.deleteConfirmBody")} confirmLabel={t("side.delete")}
      onCancel={() => setDeleting(undefined)} onConfirm={() => { const target = deleting; setDeleting(undefined); saveRules(rules.filter((rule) => rule.id !== target.id)); }} />}
  </SettingsPage>;
}

/* — Projects — */

export function ProjectsPage({ cwd, groups, onPickFolder, onRenameGroup, onDeleteGroup, onCreateGroup }: {
  cwd: string; groups: Group[]; onPickFolder: () => void;
  onRenameGroup: (id: string, name: string) => Promise<boolean>; onDeleteGroup: (id: string) => Promise<boolean>; onCreateGroup: (name: string) => Promise<boolean>;
}) {
  const { track } = useSaveStatus();
  const [renaming, setRenaming] = useState<{ id: string; value: string }>();
  const [deleting, setDeleting] = useState<Group>();
  const [adding, setAdding] = useState("");
  const run = (work: () => Promise<boolean>) => track(async () => { if (!await work()) throw new Error("failed"); });
  return <SettingsPage>
    <SettingsSection title={t("set.projects.folder")}>
      <SettingRow id="folder" label={t("wsset.folder")} description={cwd ? <code className="settings-code" title={cwd}>{cwd}</code> : t("set.projects.folderDesc")}>
        <button type="button" className="settings-button" onClick={onPickFolder}><FolderOpen size={14} aria-hidden="true" />{t("set.projects.change")}</button>
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.projects.list")} description={t("set.projects.listDesc")}>
      <div data-setting-id="projects">
        {groups.map((group) => renaming?.id === group.id
          ? <form key={group.id} className="setting-row settings-inline-form" onSubmit={(event) => { event.preventDefault(); const name = renaming.value.trim(); if (!name) return; void run(() => onRenameGroup(group.id, name)).then(() => setRenaming(undefined), () => undefined); }}>
            <input className="settings-input" autoFocus aria-label={t("set.projects.rename", { name: group.name })} value={renaming.value} maxLength={80} onChange={(event) => setRenaming({ id: group.id, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRenaming(undefined); } }} />
            <button type="submit" className="settings-icon" aria-label={t("side.saveName")} disabled={!renaming.value.trim()}><Check size={14} /></button>
            <button type="button" className="settings-icon" aria-label={t("side.cancelRename")} onClick={() => setRenaming(undefined)}><X size={14} /></button>
          </form>
          : <SettingRow key={group.id} icon={<FolderOpen size={15} aria-hidden="true" />} label={group.name}>
            <div className="settings-inline-actions">
              <button type="button" className="settings-icon" aria-label={t("set.projects.rename", { name: group.name })} title={t("side.rename")} onClick={() => setRenaming({ id: group.id, value: group.name })}><Pencil size={14} /></button>
              <button type="button" className="settings-icon danger" aria-label={t("set.projects.delete", { name: group.name })} title={t("side.delete")} onClick={() => setDeleting(group)}><Trash2 size={14} /></button>
            </div>
          </SettingRow>)}
        {!groups.length && <p className="settings-empty-line">{t("side.projectsEmpty")}</p>}
        <form className="setting-row settings-inline-form" onSubmit={(event) => { event.preventDefault(); const name = adding.trim(); if (!name) return; void run(() => onCreateGroup(name)).then(() => setAdding(""), () => undefined); }}>
          <input className="settings-input" aria-label={t("ob.createProject")} placeholder={t("ob.projectPlaceholder")} value={adding} maxLength={80} onChange={(event) => setAdding(event.target.value)} />
          <button type="submit" className="settings-button" disabled={!adding.trim()}><Plus size={14} aria-hidden="true" />{t("ob.create")}</button>
        </form>
      </div>
    </SettingsSection>
    {deleting && <ConfirmDialog title={t("set.projects.deleteConfirm", { name: deleting.name })} body={t("set.projects.deleteConfirmBody")} confirmLabel={t("side.delete")}
      onCancel={() => setDeleting(undefined)} onConfirm={() => { const target = deleting; setDeleting(undefined); void run(() => onDeleteGroup(target.id)).catch(() => undefined); }} />}
  </SettingsPage>;
}

