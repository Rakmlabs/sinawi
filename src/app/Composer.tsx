import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronDown, FileText, Folder, LoaderCircle, MousePointerClick, Paperclip, ShieldCheck, Shuffle, Square, WandSparkles, X } from "lucide-react";
import { ComposerPopover } from "../ComposerPopover";
import { composerAction, composerLocked, stopClickAllowed, fileToken, handlesCompletionKey, historyEntries, historyStep, slashCommandOf, slashToken, type SlashCommand } from "../composer";
import { continueListOnNewline, indentListLine, isImeComposing, listItemAt } from "../composer-lists";
import { applyFieldEdit } from "./field-edit";
import type { SlashItem } from "./useComposerCompletion";
import { kindFromName } from "../../server/media-kinds";
import { formatBytes, kindLabel, type MediaRef } from "../viewer-model";
import { names } from "./labels";
import type { AttachmentsState } from "./useAttachments";
import type { ComposerCompletion } from "./useComposerCompletion";
import type { AgentId, PermissionMode, Session, SkillInfo as Skill } from "../../server/types";
import { GlassSelect } from "../GlassSelect";
import { t } from "../i18n";
import { isWorkspacePolicyMessage } from "../../server/workspace-policy";
import { Beat } from "../Beat";

export type ComposerProps = {
  completion: ComposerCompletion;
  attachments: AttachmentsState;
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  skills: string[];
  messageSkills: string[];
  setMessageSkills: React.Dispatch<React.SetStateAction<string[]>>;
  availableSkills: Skill[];
  active: Session | undefined;
  sessionRunning: boolean;
  busy: boolean;
  routing: boolean;
  liveNote: string;
  chatError: string;
  unavailableWarning: string | undefined;
  /** Opens Settings › Workspaces; offered when something is blocked by this workspace's settings. */
  onOpenWorkspaceSettings?: () => void;
  mode: "auto" | "manual";
  setMode: (mode: "auto" | "manual") => void;
  /** Auto-switch for the active session (or the workspace default for a new one). */
  autoSwitch: boolean;
  setAutoSwitch: (enabled: boolean) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  /** The workspace allows "전체 권한"; otherwise that mode is not offered. */
  fullAccessAllowed: boolean;
  agent: AgentId;
  cwd: string;
  shownCwd: string;
  canSend: boolean;
  choiceOptions: string[];
  send: (executeRecommendation?: boolean, message?: string) => Promise<unknown>;
  stopActive: () => void;
  openModal: (modal: string) => void;
  openViewer: (items: MediaRef[], index: number) => void;
  /** Runs a built-in `/` command (`/clear`, `/compact`, `/usage`). */
  runCommand: (command: SlashCommand) => void;
  /** Team/agent picker rendered in the bottom bar (TeamBarSlot). */
  teamPicker?: ReactNode;
};



function slashDetail(item: SlashItem): string {
  return { clear: t("comp.cmd.clear"), compact: t("comp.cmd.compact"), usage: t("comp.usageHint") }[item.command];
}

function permissionModes(fullAccessAllowed: boolean): { mode: PermissionMode; label: string; title: string }[] {
  return [
    { mode: "plan", label: t("comp.perm.plan"), title: t("comp.perm.planTitle") },
    { mode: "auto", label: t("comp.perm.auto"), title: t("comp.perm.autoTitle") },
    ...(fullAccessAllowed ? [{ mode: "full" as const, label: t("comp.perm.full"), title: t("comp.perm.fullTitle") }] : []),
  ];
}

export function Composer(props: ComposerProps) {
  const { completion, prompt, setPrompt, messageSkills, setMessageSkills, active, sessionRunning, busy, routing, liveNote, chatError, unavailableWarning, onOpenWorkspaceSettings, mode, setMode, agent, cwd, shownCwd, canSend, choiceOptions, send, stopActive, openModal, openViewer } = props;
  const { slash, setSlash, setSkillIndex, fileCompletion, setFileCompletion, fileSuggestions, setFileSuggestions, fileIndex, setFileIndex, composerInput, historyIndex, historyDraft, lastEscape, slashItems, highlightedSkill } = completion;
  const { attachments, attachFiles, removeAttachment, pasteImage, fileInput, dragging } = props.attachments;
  const skillName = (id: string) => props.availableSkills.find((skill) => skill.id === id)?.name ?? id;
  const chooseSlashItem = (item: SlashItem) => {
    if (!slash) return;
    setPrompt(prompt.slice(0, slash.start) + prompt.slice(slash.end));
    setSlash(undefined);
    props.runCommand(item.command);
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
  const action = composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length));
  // The send button turns into stop in place: a second click meant for "send" must not stop the run.
  const stopSince = useRef(0);
  useEffect(() => { stopSince.current = action === "stop" ? Date.now() : 0; }, [action]);
  const clickStop = () => { if (stopClickAllowed(stopSince.current, Date.now())) stopActive(); };
  // Caret position, so a list line can show how Shift+Enter / Tab will continue it.
  const [caret, setCaret] = useState(0);
  const listItem = listItemAt(prompt, Math.min(caret, prompt.length));
  return <div className="composer-area">
    {routing && <div className="thinking" role="status"><Beat /> {t("comp.routing")}</div>}
    {liveNote && <div className="thinking" role="status"><Beat /> {liveNote}</div>}
    {chatError && <div className="message error-banner" role="alert">{chatError}{onOpenWorkspaceSettings && isWorkspacePolicyMessage(chatError) && <button type="button" className="policy-link" onClick={onOpenWorkspaceSettings}>{t("wsset.openSettings")}</button>}</div>}
    {unavailableWarning && <p className="composer-warning" role="alert">{unavailableWarning}{onOpenWorkspaceSettings && unavailableWarning === t("team.noAllowedAgents") && <button type="button" className="policy-link" onClick={onOpenWorkspaceSettings}>{t("wsset.openSettings")}</button>}</p>}
    <div className={`composer${dragging ? " drop-target" : ""}`}>
      {slash && (
        <ComposerPopover anchor={composerInput}>
          <div className="slash-list">
            {slashItems.length ? slashItems.map((item, index) => {
              return <button type="button" role="option" id={`slash-skill-${index}`} aria-selected={highlightedSkill === index}
                className={`slash-row${highlightedSkill === index ? " highlighted" : ""}`} key={item.command}
                onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => completion.setSkillIndex(index)} onClick={() => chooseSlashItem(item)}>
                <strong>{`/${item.command}`}</strong>
                <span className="slash-kind">{t("comp.cmd.kind")}</span>
              </button>;
            }) : <p role="status">{t("comp.noCommandMatch")}</p>}
          </div>
          {slashItems[highlightedSkill] && <div className="slash-detail" aria-live="polite">{slashDetail(slashItems[highlightedSkill])}</div>}
        </ComposerPopover>
      )}
      {fileCompletion && (
        <ComposerPopover anchor={composerInput}>
          <div className="slash-heading">{t("comp.fileHeading")}</div>
          {fileSuggestions.length ? fileSuggestions.map((file, index) => <button type="button" role="option" id={`file-suggestion-${index}`} aria-selected={fileIndex === index}
            className={fileIndex === index ? "highlighted" : ""} key={file}
            onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => attachFile(file)}>
            <strong>@{file}</strong>
          </button>) : <p role="status">{t("comp.noFileMatch")}</p>}
        </ComposerPopover>
      )}
      {attachments.length > 0 && <div className="composer-attachments" aria-label={t("comp.attachments")}>
        {attachments.map((item) => {
          const remove = () => removeAttachment(item);
          if (item.kind === "element") return <span key={item.id} className="attachment-chip" tabIndex={0}>
            <MousePointerClick size={14} />
            <span className="attachment-chip-label">{item.label}{item.element?.comment ? ` · ${item.element.comment}` : ""}</span>
            <button type="button" aria-label={t("comp.detach", { label: item.label })} onClick={remove}><X size={13} /></button>
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
            <button type="button" className="chip-remove" aria-label={t("comp.detach", { label: item.label })} onClick={remove}><X size={13} /></button>
            {item.progress != null && <span className="upload-progress"><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}
          </span>;
        })}
      </div>}
      {messageSkills.length > 0 && <div className="message-skills" aria-label={t("comp.messageSkills")}>
        {messageSkills.map((id) => <button key={id} onClick={() => setMessageSkills((old) => old.filter((item) => item !== id))}
          aria-label={t("comp.detach", { label: skillName(id) })}>
          <WandSparkles size={12} />{skillName(id)}<X size={12} />
        </button>)}
      </div>}
      <textarea
        ref={composerInput}
        className={listItem ? "list-line" : undefined}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        disabled={composerLocked(sessionRunning, busy)}
        onPaste={pasteImage}
        aria-controls={slash || fileCompletion ? "slash-skills" : undefined}
        aria-expanded={Boolean(slash || fileCompletion)}
        aria-autocomplete="list"
        onBlur={() => { setSlash(undefined); setFileCompletion(undefined); }}
        aria-activedescendant={slash && slashItems.length ? `slash-skill-${highlightedSkill}` : fileCompletion && fileSuggestions.length ? `file-suggestion-${fileIndex}` : undefined}
        aria-label={t("comp.inputLabel")}
        title={t("comp.inputTitle")}
        placeholder={sessionRunning ? t("comp.placeholderRunning") : !active && mode === "auto" ? t("comp.placeholderAuto") : t("comp.placeholderAgent", { agent: active ? names[active.agent] : names[agent] })}
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
          // Hangul IME: the key that commits a syllable must not send, continue a list or indent.
          if (isImeComposing(e.nativeEvent)) return;
          // Enter with nothing to complete (`/xyz`, `@nomatch`) closes the list and sends as usual.
          const unmatchedEnter = e.key === "Enter" && !e.shiftKey && ((fileCompletion && !fileSuggestions.length) || (slash && !slashItems.length));
          if (unmatchedEnter) { setFileCompletion(undefined); setSlash(undefined); }
          if (!unmatchedEnter && fileCompletion && handlesCompletionKey(e.key, e.shiftKey)) {
            e.preventDefault();
            if (e.key === "Escape") setFileCompletion(undefined);
            else if ((e.key === "Enter" || e.key === "Tab") && fileSuggestions[fileIndex]) attachFile(fileSuggestions[fileIndex]);
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") setFileIndex((fileIndex + (e.key === "ArrowDown" ? 1 : -1) + fileSuggestions.length) % Math.max(1, fileSuggestions.length));
            return;
          }
          if (!unmatchedEnter && slash && handlesCompletionKey(e.key, e.shiftKey)) {
            e.preventDefault();
            if (e.key === "Escape") setSlash(undefined);
            else if (e.key === "Enter" || e.key === "Tab") { if (slashItems[highlightedSkill]) chooseSlashItem(slashItems[highlightedSkill]); }
            else setSkillIndex((highlightedSkill + (e.key === "ArrowDown" ? 1 : -1) + slashItems.length) % Math.max(1, slashItems.length));
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
          // Markdown list continuation; completion popups already returned above, so Tab only lands here when none is open.
          // Read the DOM, not `prompt`: with fast typing the textarea is the source of truth.
          const field = e.currentTarget;
          const listEdit = e.key === "Enter" && e.shiftKey
            ? continueListOnNewline(field.value, field.selectionStart, field.selectionEnd)
            : e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey
              ? indentListLine(field.value, field.selectionStart, e.shiftKey)
              : undefined;
          if (listEdit) {
            e.preventDefault();
            applyFieldEdit(field, listEdit.value, listEdit.caret);
            setCaret(listEdit.caret);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bottom">
        <button
          className="directory-button"
          disabled={Boolean(active)}
          onClick={() => openModal("directory")}
          aria-label={t("comp.folderLabel", { folder: shownCwd || t("comp.chooseFolder") })}
          title={
            active
              ? t("comp.folderLocked")
              : cwd
          }
        >
          <Folder size={14} />
          <span>
            {shownCwd
              ? shownCwd.split("/").filter(Boolean).at(-1) || "/"
              : t("comp.chooseFolder")}
          </span>
          <ChevronDown size={12} />
        </button>
        {props.teamPicker}
        {!active && <div className="routing-mode" role="group" aria-label={t("comp.routingMode")}>
          <button type="button" aria-pressed={mode === "auto"} disabled={busy} title={t("comp.autoTitle")} onClick={() => setMode("auto")}>{t("comp.auto")}</button>
          <button type="button" aria-pressed={mode === "manual"} disabled={busy} title={t("comp.manualTitle")} onClick={() => setMode("manual")}>{t("comp.manual")}</button>
        </div>}
        {(active ? active.mode === "auto" : mode === "auto") && <button type="button" className="auto-switch-toggle" aria-pressed={props.autoSwitch} disabled={busy || sessionRunning}
          title={t(props.autoSwitch ? "comp.autoSwitchOnTitle" : "comp.autoSwitchOffTitle")} onClick={() => props.setAutoSwitch(!props.autoSwitch)}>
          <Shuffle size={12} aria-hidden="true" />{t(props.autoSwitch ? "comp.autoSwitchOn" : "comp.autoSwitchOff")}
        </button>}
        <GlassSelect label={t("comp.permissionMode")} value={props.permissionMode} disabled={busy || sessionRunning}
          className={`permission-picker${props.permissionMode === "full" ? " danger" : ""}`}
          onChange={(value) => props.setPermissionMode(value as PermissionMode)}
          options={permissionModes(props.fullAccessAllowed).map((item) => ({ value: item.mode, label: item.label, title: item.title, icon: <ShieldCheck size={13} aria-hidden="true" /> }))} />
        <span className="composer-bottom-spacer" />
        {listItem && <span className="composer-list-hint" aria-hidden="true">{t(listItem.ordered ? "comp.listHintOrdered" : "comp.listHintBullet")}</span>}
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => { attachFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <button type="button" className="icon-button" aria-label={t("comp.attachFile")} title={t("comp.attachTitle")} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
        <button
          type="button"
          className="send-button"
          title={action === "stop" ? t("comp.stopTitle") : t("comp.sendTitle")}
          aria-label={action === "stop" ? t("comp.stop") : routing ? t("comp.routing") : t("comp.send")}
          disabled={action === "stop" ? busy : !canSend && !slashCommandOf(prompt)}
          onClick={action === "stop" ? clickStop : () => void send()}
        >
          {action === "stop" ? (
            <Square size={16} fill="currentColor" />
          ) : busy && !sessionRunning ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowUp size={19} />
          )}
        </button>
      </div>
    </div>
  </div>;
}
