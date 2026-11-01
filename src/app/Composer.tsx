import { ArrowUp, ChevronDown, FileText, Folder, LoaderCircle, MousePointerClick, Paperclip, Settings2, Square, WandSparkles, X } from "lucide-react";
import { ComposerPopover } from "../ComposerPopover";
import { composerAction, composerLocked, fileToken, handlesCompletionKey, historyEntries, historyStep, isUsageCommand, slashToken } from "../composer";
import { kindFromName } from "../../server/media-kinds";
import { formatBytes, kindLabel, type MediaRef } from "../viewer-model";
import { names } from "./labels";
import type { AttachmentsState } from "./useAttachments";
import type { ComposerCompletion } from "./useComposerCompletion";
import type { AgentId, Session, SkillInfo as Skill } from "../../server/types";

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
  mode: "auto" | "manual";
  setMode: (mode: "auto" | "manual") => void;
  agent: AgentId;
  cwd: string;
  shownCwd: string;
  canSend: boolean;
  choiceOptions: string[];
  send: (executeRecommendation?: boolean, message?: string) => Promise<unknown>;
  stopActive: () => void;
  openModal: (modal: string) => void;
  openViewer: (items: MediaRef[], index: number) => void;
};

export function Composer(props: ComposerProps) {
  const { completion, prompt, setPrompt, skills, messageSkills, setMessageSkills, active, sessionRunning, busy, routing, liveNote, chatError, unavailableWarning, mode, setMode, agent, cwd, shownCwd, canSend, choiceOptions, send, stopActive, openModal, openViewer } = props;
  const { slash, setSlash, setSkillIndex, fileCompletion, setFileCompletion, fileSuggestions, setFileSuggestions, fileIndex, setFileIndex, composerInput, historyIndex, historyDraft, lastEscape, filteredSkills, highlightedSkill } = completion;
  const { attachments, attachFiles, removeAttachment, pasteImage, fileInput, dragging } = props.attachments;
  const skillName = (id: string) => props.availableSkills.find((skill) => skill.id === id)?.name ?? id;
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
  const action = composerAction(sessionRunning, Boolean(prompt.trim() || attachments.length));
  return <div className="composer-area">
    {routing && <div className="thinking" role="status"><LoaderCircle size={14} className="spin" /> 팀 고르는 중…</div>}
    {liveNote && <div className="thinking" role="status"><LoaderCircle size={14} className="spin" /> {liveNote}</div>}
    {chatError && <div className="message error-banner" role="alert">{chatError}</div>}
    {unavailableWarning && <p className="composer-warning" role="alert">{unavailableWarning}</p>}
    <div className={`composer${dragging ? " drop-target" : ""}`}>
      {slash && (
        <ComposerPopover anchor={composerInput}>
          {(!slash.query || "usage".startsWith(slash.query.toLowerCase())) && <button type="button" role="option" aria-selected={false} onPointerDown={(event) => event.preventDefault()} onClick={() => { openModal("usage"); setPrompt(prompt.slice(0, slash.start) + prompt.slice(slash.end)); setSlash(undefined); }}><strong>/usage</strong><small>에이전트·모델별 사용량 보기</small></button>}
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
          const remove = () => removeAttachment(item);
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
          aria-label={`${skillName(id)} 첨부 해제`}>
          <WandSparkles size={12} />{skillName(id)}<X size={12} />
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
          onClick={() => openModal("directory")}
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
        <button className="icon-button" aria-label="모델 및 시스템 프롬프트" onClick={() => openModal("settings")}><Settings2 size={16} /></button>
        <button
          className="send-button"
          aria-label={action === "stop" ? "작업 중지" : routing ? "팀 고르는 중…" : "메시지 보내기"}
          disabled={action === "stop" ? busy : !canSend && !isUsageCommand(prompt)}
          onClick={action === "stop" ? stopActive : () => void send()}
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
    <div className="composer-hints">실행 중에도 입력 · Enter 전송 · ⇧Enter 줄바꿈 · ↑↓ 기록 · Esc/⌃C 중지 · / 스킬 · @ 파일 · ⌘V·드래그 첨부 · ⌘⇧B 브라우저</div>
  </div>;
}
