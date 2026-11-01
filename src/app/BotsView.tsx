import { ArrowRight, Bot, ChevronDown, Folder, Plus, Trash2, Users } from "lucide-react";
import { AgentMark } from "../AgentMark";
import { GlassSelect } from "../GlassSelect";
import { names } from "./labels";
import type { Bot as Preset } from "../../server/types";
import { t } from "../i18n";

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
    <section className="panel full-panel">
      <div className="panel-header">
        <h2>{t("bots.title")}</h2>
        <button
          className="button light small"
          onClick={onCreate}
        >
          <Plus size={14} />
          {t("bots.create")}
        </button>
      </div>
      {!bots.length ? (
        <div className="page-empty">
          <Bot size={36} />
          <h2>{t("bots.emptyTitle")}</h2>
          <p>{t("bots.emptyBody")}</p>
          <button
            className="button primary"
            onClick={onCreate}
          >
            {t("bots.createFirst")} <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        bots.map((b) => (
          <div className="bot-row" key={b.id}>
            <AgentMark agent={b.agent} />
            <div>
              <strong>{b.name}</strong>
              <small>
                {names[b.agent]} · {b.model || t("bots.cliDefault")} ·{" "}
                {t("bots.skillCount", { n: b.skills.length })}
              </small>
            </div>
            <button
              className="icon-button"
              title={t("bots.use")}
              onClick={() => onUse(b)}
            >
              <ArrowRight size={17} />
            </button>
            <button
              className="icon-button"
              title={t("bots.delete")}
              onClick={() => onDelete(b)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))
      )}
    </section>
    <section className="panel bot-conversation">
      <h2>{t("bots.convTitle")}</h2>
      <p>
        {t("bots.convBody1")}
        <br />
        {t("bots.convBody2")}
      </p>
      <label>
        {t("bots.first")}
        <GlassSelect label={t("bots.first")} value={botA} onChange={setBotA} options={[{ value: "", label: t("bots.pick") }, ...bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
      </label>
      <label>
        {t("bots.second")}
        <GlassSelect label={t("bots.second")} value={botB} onChange={setBotB} options={[{ value: "", label: t("bots.pick") }, ...bots.map((bot) => ({ value: bot.id, label: bot.name }))]} />
      </label>
      <label>
        {t("bots.turns")}
        <input
          type="number"
          min={1}
          max={20}
          value={turns}
          onChange={(e) => setTurns(Number(e.target.value))}
        />
      </label>
      <label>
        {t("bots.topic")}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("bots.topicPlaceholder")}
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
        {t("bots.start")}
      </button>
    </section>
  </div>;
}
