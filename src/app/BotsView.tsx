import { ArrowRight, Bot, ChevronDown, Folder, Plus, Trash2, Users } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { names } from "./labels";
import type { Bot as Preset } from "../../server/types";

export type BotsViewProps = {
  bots: Preset[];
  botA: string; setBotA: (id: string) => void;
  botB: string; setBotB: (id: string) => void;
  turns: number; setTurns: (turns: number) => void;
  prompt: string; setPrompt: (prompt: string) => void;
  cwd: string;
  busy: boolean;
  connected: boolean;
  onCreate: () => void;
  onPickFolder: () => void;
  onUse: (bot: Preset) => void;
  onDelete: (bot: Preset) => void;
  onStart: () => void;
};

/** "봇" tab: saved bot presets and a two-bot conversation launcher. */
export function BotsView({ bots, botA, setBotA, botB, setBotB, turns, setTurns, prompt, setPrompt, cwd, busy, connected, onCreate, onPickFolder, onUse, onDelete, onStart }: BotsViewProps) {
  return <div className="bots-grid">
    <section className="glass full-panel">
      <div className="panel-header">
        <h2>내 봇</h2>
        <button
          className="button light small"
          onClick={onCreate}
        >
          <Plus size={14} />
          봇 만들기
        </button>
      </div>
      {!bots.length ? (
        <div className="page-empty">
          <Bot size={36} />
          <h2>에이전트마다 알맞은 역할을.</h2>
          <p>
            에이전트, 모델, 스킬, 지침을 봇으로 저장하고
            언제든 다시 활용하세요.
          </p>
          <button
            className="button primary"
            onClick={onCreate}
          >
            첫 봇 만들기 <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        bots.map((b) => (
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
              onClick={() => onUse(b)}
            >
              <ArrowRight size={17} />
            </button>
            <button
              className="icon-button"
              title="봇 삭제"
              onClick={() => onDelete(b)}
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
        <GlassSelect label="첫 번째 봇" value={botA} onChange={setBotA} options={[{ value: "", label: "봇 선택" }, ...bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
      </label>
      <label>
        두 번째 봇
        <GlassSelect label="두 번째 봇" value={botB} onChange={setBotB} options={[{ value: "", label: "봇 선택" }, ...bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
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
        onClick={onPickFolder}
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
        onClick={onStart}
      >
        <Users size={16} />
        대화 시작
      </button>
    </section>
  </div>;
}
