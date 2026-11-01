import { Activity, Check, LoaderCircle, Search, WandSparkles, X } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { FolderPicker } from "../FolderPicker";
import { GlassSelect } from "../GlassSelect";
import { UsagePanel } from "../UsagePanel";
import { ModelChoice } from "../RoutingControls";
import { RemainingChip } from "../QuotaContext";
import { ONBOARDING_OPEN_EVENT } from "../onboarding-state";
import { names } from "./labels";
import type { Bootstrap } from "./api";
import type { RoutingSettings } from "../../server/routing";
import type { AgentId, SkillInfo as Skill, WorkspaceId } from "../../server/types";

export type AppModalProps = {
  modal: string;
  setModal: (modal: string | undefined) => void;
  workspaceId: WorkspaceId;
  error: string;
  clearError: () => void;
  busy: boolean;
  agents: Bootstrap["agents"];
  availableSkills: Skill[];
  skills: string[];
  setSkills: React.Dispatch<React.SetStateAction<string[]>>;
  search: string;
  setSearch: (value: string) => void;
  skillReturn: string | undefined;
  setSkillReturn: (value: string | undefined) => void;
  shownCwd: string;
  cwd: string;
  onUseFolder: (path: string) => void;
  botName: string;
  setBotName: (value: string) => void;
  agent: AgentId;
  chooseAgent: (id: AgentId) => void;
  allowedAgents: AgentId[];
  model: string;
  reasoningEffort: string;
  onModelChange: (model: string, reasoningEffort: string) => void;
  routingSettings: RoutingSettings | undefined;
  autoSwitch: boolean;
  setAutoSwitch: (value: boolean) => void;
  systemPrompt: string;
  setSystemPrompt: (value: string) => void;
  onOpenRouting: () => void;
  onRefreshSkills: () => void;
  onSaveBot: () => void;
};

const titles: Record<string, string> = {
  usage: "사용량",
  skills: "팀 스킬 설정",
  directory: "작업 폴더",
  bot: "봇 만들기",
  settings: "세션 설정",
};

const reopenOnboarding = (close: () => void) => { close(); window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT)); };

/** Usage, skills, folder, session settings, bot and help dialogs. */
export function AppModal(props: AppModalProps) {
  const { modal, setModal, workspaceId, error, clearError, busy, skills, setSkills, search, setSearch, shownCwd, agent, allowedAgents, model, reasoningEffort, routingSettings, autoSwitch, setAutoSwitch, systemPrompt, setSystemPrompt } = props;
  const close = () => setModal(undefined);
  return <div className="modal-backdrop" onClick={close}>
    <section
      className={`glass modal ${modal === "usage" ? "usage-modal" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="panel-header">
        <h2 id="modal-title">
          {titles[modal] ?? "내 컴퓨터의 에이전트 팀"}
        </h2>
        <button
          className="icon-button"
          onClick={close}
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
              onClick={clearError}
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
            <button className="button light" disabled={busy || !shownCwd} onClick={props.onRefreshSkills}>{busy ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}스킬 새로고침</button>
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
              {props.availableSkills
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
              {!props.availableSkills.length && (
                <p>
                  스킬을 찾을 수 없습니다. ./skills 또는 에이전트의 스킬 폴더에
                  SKILL.md 파일을 추가한 뒤 새로고침하세요.
                </p>
              )}
            </div>
            <button
              className="button primary"
              onClick={() => {
                setModal(props.skillReturn);
                props.setSkillReturn(undefined);
              }}
            >
              스킬 {skills.length}개 사용 <Check size={15} />
            </button>
          </>
        )}
        {modal === "usage" && <UsagePanel initialWorkspace={workspaceId} />}
        {modal === "directory" && <FolderPicker key={workspaceId} workspaceId={workspaceId} currentPath={props.cwd} onUse={props.onUseFolder} />}
        {(modal === "settings" || modal === "bot") && (
          <>
            {modal === "bot" && (
              <label>
                봇 이름
                <input
                  value={props.botName}
                  onChange={(e) => props.setBotName(e.target.value)}
                  placeholder="예: 꼼꼼한 코드 검토자"
                />
              </label>
            )}
            <label>
              에이전트
              <GlassSelect label="에이전트" value={agent} disabled={busy} onChange={(value) => props.chooseAgent(value as AgentId)} options={(["codex", "claude", "grok"] as AgentId[]).map((id) => ({ value: id, label: names[id], icon: <><AgentMark agent={id} size="small" /><RemainingChip agent={id} /></>, disabled: !allowedAgents.includes(id), title: workspaceId === "company" && id === "codex" ? "회사 공간에서는 사용 안 함" : undefined }))} />
            </label>
            <ModelChoice disabled={busy} label="세션 모델" value={{ agent, model, reasoningEffort }} settings={routingSettings} chooseAgent={false} onChange={(next) => props.onModelChange(next.model ?? "", next.reasoningEffort ?? "")} />
            {modal === "settings" && <label className="auto-switch-setting">
              <span><strong>대화 중 자동 전환</strong><small>자동 모드에서 작업 종류가 명확히 바뀌면 알맞은 오케스트라로 전환합니다.</small></span>
              <input type="checkbox" checked={autoSwitch} disabled={busy} onChange={(event) => setAutoSwitch(event.target.checked)} />
            </label>}
            {modal === "settings" && <button className="button light" onClick={props.onOpenRouting}>자동 라우팅 규칙과 모델 목록 편집</button>}
            {modal === "settings" && <button className="button light" onClick={() => reopenOnboarding(close)}>설정 도우미 다시 열기</button>}
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
                props.setSkillReturn(modal);
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
              disabled={busy || (modal === "bot" && !props.botName.trim())}
              onClick={() => modal === "bot" ? props.onSaveBot() : close()}
            >
              {modal === "bot" ? "봇 저장" : "완료"}
              <Check size={15} />
            </button>
          </>
        )}
        {modal === "help" && (
          <>
            <button className="button primary onboarding-reopen" onClick={() => reopenOnboarding(close)}>설정 도우미 다시 열기</button>
            <p>
              오케스트라는 설치된 에이전트 CLI를 실행하고
              활동 내역을 하나의 작업 공간에 실시간으로 표시합니다.
              총괄 에이전트와 작업 에이전트를 선택한 뒤 작업을 요청하세요.
            </p>
            <div className="cli-status-list">
              {props.agents.map((a) => (
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
  </div>;
}
