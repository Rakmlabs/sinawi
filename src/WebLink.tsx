import { useState, type ReactNode } from "react";
import { AppWindow, Copy, ExternalLink } from "lucide-react";
import { ContextMenu } from "./SidebarMenu";
import { writeClipboard } from "./CopyButton";
import { APP_ERROR_EVENT, linkTarget, openExternal, openInApp } from "./link-open";
import { t } from "./i18n";

const fail = (error: unknown) => window.dispatchEvent(new CustomEvent(APP_ERROR_EVENT, { detail: t("link.openFailed", { error: error instanceof Error ? error.message : String(error) }) }));

/**
 * A link in the chat. A click asks where to open it (in-app browser or the default browser);
 * ⌘-click goes straight to the default browser. mailto: and the like go to the system.
 */
export function WebLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const target = linkTarget(href);
  const click = (event: React.MouseEvent) => {
    if (target === "none") { if (!href.startsWith("#")) event.preventDefault(); return; }
    event.preventDefault();
    if (target === "system" || event.metaKey || event.ctrlKey) { void openExternal(href).catch(fail); return; }
    setMenu({ x: event.clientX, y: event.clientY + 6 });
  };
  return <>
    <a href={href} className={className} rel="noreferrer" title={href} onClick={click}>{children}</a>
    {menu && <ContextMenu x={menu.x} y={menu.y} label={t("link.menu")} onClose={() => setMenu(undefined)} items={[
      { kind: "action", label: t("link.inApp"), icon: <AppWindow size={14} />, onSelect: () => openInApp(href) },
      { kind: "action", label: t("link.external"), icon: <ExternalLink size={14} />, meta: <kbd>{t("link.cmdClick")}</kbd>, onSelect: () => void openExternal(href).catch(fail) },
      { kind: "separator" },
      { kind: "action", label: t("link.copy"), icon: <Copy size={14} />, onSelect: () => { let clipboard; try { clipboard = navigator.clipboard; } catch { clipboard = undefined; } void writeClipboard(href, clipboard); } },
    ]} />}
  </>;
}
