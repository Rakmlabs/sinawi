// Settings → Connect an outside AI: how Claude Code, Codex, Grok Build, Claude Desktop, Cursor or any
// MCP client connects to Sinawi to hand work to leads (server/app-mcp.ts clientSetups), what the user
// then sees, and the token. The commands come from the server, which knows the bridge's path.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ExternalLink, Plug } from "lucide-react";
import { t, useT } from "../i18n";
import { workspaceApi } from "../app/api";
import { CopyButton } from "../CopyButton";
import { WebLink } from "../WebLink";
import { ConfirmDialog, SettingRow, SettingsPage, SettingsSection } from "./controls";

type ClientSetup = { id: "claude-code" | "codex" | "grok" | "claude-desktop" | "cursor" | "other"; name: string; command?: string; config?: string; configFile?: string; check?: string };
type McpConnection = { token: string; tokenFile: string; script: string | null; clients?: ClientSetup[]; scriptConfig?: unknown };
type OneClick = "claude" | "cursor";
type McpClientPlan = { client: OneClick; name: string; path: string; exists: boolean; replaces: boolean; upToDate: boolean; merge: string };

const ONE_CLICK: Partial<Record<ClientSetup["id"], OneClick>> = { "claude-desktop": "claude", cursor: "cursor" };
const DOCS_URL = "https://github.com/Rakmlabs/sinawi/blob/main/docs/mcp-clients.md";

/** The connect routes (server/mcp-clients.ts) answer with a `code` for files Sinawi will not rewrite. */
async function mcpClientApi<T>(client: OneClick, merge?: string): Promise<T> {
  const r = await fetch(`/api/app-mcp/clients/${client}${merge === undefined ? "/plan" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(merge === undefined ? {} : { merge }) });
  const data = await r.json().catch(() => undefined);
  if (r.ok) return data as T;
  const code = data?.code;
  if (code === "invalid_json" || code === "not_object" || code === "bad_servers") throw new Error(t("set.general.mcpConnectBadFile", { path: data.path }));
  if (code === "stale") throw new Error(t("set.general.mcpConnectStale"));
  throw new Error(data?.error || t("api.requestFailed"));
}

/** Claude Desktop / Cursor: show exactly what is merged into the client's config, then write it. */
function OneClickConnect({ client, fail }: { client: OneClick; fail: (reason: unknown) => void }) {
  const [plan, setPlan] = useState<McpClientPlan>();
  const [done, setDone] = useState("");
  const open = () => { setDone(""); mcpClientApi<McpClientPlan>(client).then(setPlan, fail); };
  const write = () => {
    const current = plan;
    setPlan(undefined);
    if (!current) return;
    mcpClientApi<{ path: string; backup: string | null; name: string }>(current.client, current.merge).then((result) => {
      setDone(result.backup ? t("set.general.mcpConnectDoneBackup", { name: result.name, path: result.path, backup: result.backup }) : t("set.general.mcpConnectDone", { name: result.name, path: result.path }));
    }, fail);
  };
  return <>
    <div className="settings-advanced-actions">
      <button type="button" className="settings-button primary" onClick={open}>{t(client === "claude" ? "set.general.mcpConnectClaude" : "set.general.mcpConnectCursor")}</button>
    </div>
    <p className="connect-hint">{t("set.general.mcpConnectIntro")}</p>
    {done && <p role="status" className="connect-done">{done}</p>}
    {plan && <ConfirmDialog title={t("set.general.mcpConnectConfirm", { name: plan.name })}
      body={<>
        {t(plan.exists ? (plan.replaces ? "set.general.mcpConnectReplace" : "set.general.mcpConnectMerge") : "set.general.mcpConnectCreate", { path: plan.path })}
        <code className="settings-confirm-code connect-merge">{plan.merge}</code>
        {t("set.general.mcpConnectRestart", { name: plan.name })}
      </>}
      confirmLabel={t("set.general.mcpConnectWrite")} onConfirm={write} onCancel={() => setPlan(undefined)} />}
  </>;
}

function CodeBlock({ label, text }: { label: string; text: string }) {
  return <div className="connect-code">
    <div className="connect-code-head"><span>{label}</span><CopyButton text={text} ariaLabel={t("set.connect.copyWhat", { what: label })} className="settings-button" showLabel /></div>
    <pre tabIndex={0} aria-label={label}><code>{text}</code></pre>
  </div>;
}

function ClientTabs({ clients, fail }: { clients: ClientSetup[]; fail: (reason: unknown) => void }) {
  const [active, setActive] = useState<ClientSetup["id"]>(clients[0]?.id ?? "claude-code");
  const list = useRef<HTMLDivElement>(null);
  const client = clients.find((item) => item.id === active) ?? clients[0];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = clients.findIndex((item) => item.id === active);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: clients.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = clients[(next + clients.length) % clients.length];
    setActive(target.id);
    list.current?.querySelector<HTMLButtonElement>(`#connect-tab-${target.id}`)?.focus();
  };
  if (!client) return null;
  const oneClick = ONE_CLICK[client.id];
  return <div className="connect-clients">
    <div ref={list} className="connect-tabs" role="tablist" aria-label={t("set.connect.clients")} onKeyDown={onKeyDown}>
      {clients.map((item) => <button key={item.id} id={`connect-tab-${item.id}`} type="button" role="tab" aria-selected={item.id === client.id} aria-controls="connect-panel"
        tabIndex={item.id === client.id ? 0 : -1} className={`connect-tab${item.id === client.id ? " active" : ""}`} onClick={() => setActive(item.id)}>
        {item.id === "other" ? t("set.connect.other") : item.name}
      </button>)}
    </div>
    <div id="connect-panel" role="tabpanel" aria-labelledby={`connect-tab-${client.id}`} className="connect-panel">
      {oneClick && <OneClickConnect client={oneClick} fail={fail} />}
      {client.command && <>
        <p>{t("set.connect.runInTerminal", { name: client.name })}</p>
        <CodeBlock label={t("set.connect.command")} text={client.command} />
      </>}
      {client.config && <>
        <p>{client.configFile
          ? t(client.command ? "set.connect.orConfig" : "set.connect.config", { file: client.configFile, name: client.name })
          : t("set.connect.otherConfig")}</p>
        <CodeBlock label={client.configFile ?? "mcpServers"} text={client.config} />
      </>}
      {client.check && <p className="connect-hint">{t("set.connect.check")} <code className="settings-code">{client.check}</code></p>}
      <p className="connect-hint">{t(client.command ? "set.connect.restartCli" : "set.connect.restartApp", { name: client.name })}</p>
    </div>
  </div>;
}

export function ConnectPage() {
  useT();
  const [connection, setConnection] = useState<McpConnection>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => {
    let live = true;
    workspaceApi<McpConnection>("/app-mcp/connection", {}).then((next) => { if (live) setConnection(next); }, (reason) => { if (live) fail(reason); });
    return () => { live = false; };
  }, []);
  const rotate = () => {
    setConfirm(false); setError("");
    workspaceApi<McpConnection>("/app-mcp/token", {}).then(setConnection, fail);
  };
  const withToken = connection?.scriptConfig ? JSON.stringify(connection.scriptConfig, null, 2) : "";
  return <SettingsPage>
    <SettingsSection title={t("set.connect.what")}>
      <div className="connect-intro">
        <Plug size={20} aria-hidden="true" className="connect-intro-icon" />
        <div>
          <p className="connect-lead">{t("set.connect.lead")}</p>
          <ol className="connect-steps">
            <li>{t("set.connect.step1")}</li>
            <li>{t("set.connect.step2")}</li>
            <li>{t("set.connect.step3")}</li>
          </ol>
          <p className="connect-hint">{t("set.connect.appOn")}</p>
        </div>
      </div>
    </SettingsSection>
    <SettingsSection title={t("set.connect.how")}>
      <SettingRow id="appMcp" block label={t("set.connect.pick")} description={t("set.connect.pickDesc")} error={error || undefined}>
        <div className="connect-body">
        {!connection ? <p className="connect-hint">{t("set.connect.loading")}</p>
          : connection.clients?.length ? <ClientTabs clients={connection.clients} fail={fail} />
          : <p>{t("set.connect.noScript")}</p>}
        <p className="connect-hint">{t("set.connect.npx")}</p>
        <WebLink className="settings-link" href={DOCS_URL}>{t("set.connect.docs")} <ExternalLink size={11} aria-hidden="true" /></WebLink>
        </div>
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.connect.brief")}>
      <SettingRow id="appMcpBrief" block label={t("set.connect.briefLabel")} description={t("set.connect.briefDesc")}>
        <CodeBlock label={t("set.connect.briefLabel")} text={t("set.connect.briefText")} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t("set.connect.token")}>
      <SettingRow id="appMcpToken" block label={t("set.connect.tokenLabel")} description={t("set.connect.tokenDesc")}>
        <div className="connect-body">
        {connection && <p className="connect-hint">{t("set.connect.tokenFile")} <code className="settings-code">{connection.tokenFile}</code></p>}
        <div className="settings-advanced-actions">
          <button type="button" className="settings-button" disabled={!connection} onClick={() => setConfirm(true)}>{t("set.general.mcpRotate")}</button>
        </div>
        {withToken && <details className="connect-details">
          <summary>{t("set.connect.withToken")}</summary>
          <CodeBlock label="mcpServers" text={withToken} />
        </details>}
        </div>
      </SettingRow>
    </SettingsSection>
    {confirm && <ConfirmDialog title={t("set.general.mcpRotateConfirm")} body={t("set.general.mcpRotateBody")} confirmLabel={t("set.general.mcpRotate")} onConfirm={rotate} onCancel={() => setConfirm(false)} />}
  </SettingsPage>;
}
