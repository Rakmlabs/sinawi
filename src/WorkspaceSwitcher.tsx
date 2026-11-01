import { useState } from "react";
import { ChevronDown, Layers, Settings2 } from "lucide-react";
import { ContextMenu, type MenuItem } from "./SidebarMenu";
import { useWorkspaces } from "./workspace-context";
import { workspaceName } from "./workspaces";
import { t } from "./i18n";

const SHORTCUTS = ["F1", "F2"];

/**
 * Title-bar workspace switcher: "current ▾" opens a menu of every workspace with its running count
 * and a "manage" entry. Renders nothing while only one workspace exists.
 */
export function WorkspaceSwitcher({ onManage }: { onManage: () => void }) {
  const { workspaces, currentId, running, switchTo } = useWorkspaces();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  if (workspaces.length < 2 || !currentId) return null;
  const current = workspaceName(workspaces, currentId);
  const elsewhere = Object.entries(running).reduce((sum, [id, count]) => id === currentId ? sum : sum + count, 0);
  const items: MenuItem[] = [
    ...workspaces.map((workspace, index): MenuItem => ({
      kind: "action", label: workspaceName(workspaces, workspace.id), checked: workspace.id === currentId,
      meta: <>{(running[workspace.id] ?? 0) > 0 && <span className="ctx-count" aria-label={t("workspace.runningCount", { count: running[workspace.id] })}>{running[workspace.id]}</span>}{SHORTCUTS[index] && <kbd aria-hidden="true">{SHORTCUTS[index]}</kbd>}</>,
      onSelect: () => switchTo(workspace.id),
    })),
    { kind: "separator" },
    { kind: "action", label: t("workspace.manage"), icon: <Settings2 size={15} />, onSelect: onManage },
  ];
  return <>
    <button type="button" className="workspace-switcher" aria-haspopup="menu" aria-expanded={Boolean(menu)}
      aria-label={t("workspace.switcherLabel", { name: current })} title={t("workspace.switcherTitle")}
      onClick={(event) => {
        if (menu) { setMenu(undefined); return; }
        const box = event.currentTarget.getBoundingClientRect();
        setMenu({ x: box.left, y: box.bottom + 6 });
      }}>
      <Layers size={15} aria-hidden="true" />
      <span className="workspace-switcher-label">{current}</span>
      {elsewhere > 0 && <span className="workspace-running-badge" aria-label={t("workspace.elsewhereRunning", { count: elsewhere })}>{elsewhere}</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {menu && <ContextMenu x={menu.x} y={menu.y} label={t("workspace.menu")} items={items} onClose={() => setMenu(undefined)} />}
  </>;
}
