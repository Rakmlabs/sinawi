import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Folder, Inbox } from "lucide-react";
import { t } from "./i18n";

export type MenuItem =
  | { kind: "action"; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; title?: string; onSelect: () => void }
  | { kind: "submenu"; label: string; icon?: ReactNode; disabled?: boolean; items: TreeOption[]; onPick: (id: string | null) => void }
  | { kind: "separator" };
export type TreeOption = { id: string | null; label: string; depth: number; checked: boolean; folder?: boolean };

/** Builds a depth-first tree of groups (parentId is optional; flat groups render at depth 1). */
export function groupTree(groups: Array<{ id: string; name: string; parentId?: string }>, currentId: string | undefined): TreeOption[] {
  const ids = new Set(groups.map((group) => group.id));
  const children = (parent?: string) => groups.filter((group) => (group.parentId && ids.has(group.parentId) ? group.parentId : undefined) === parent);
  const out: TreeOption[] = [{ id: null, label: t("sidebarMenu.unsorted"), depth: 0, checked: !currentId || !ids.has(currentId) }];
  const walk = (parent: string | undefined, depth: number, seen: Set<string>) => {
    for (const group of children(parent)) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      out.push({ id: group.id, label: group.name, depth, checked: group.id === currentId, folder: true });
      walk(group.id, depth + 1, seen);
    }
  };
  walk(undefined, 1, new Set());
  return out;
}

export function clampMenu(x: number, y: number, width: number, height: number, viewportW: number, viewportH: number, margin = 8) {
  return { left: Math.max(margin, Math.min(x, viewportW - width - margin)), top: Math.max(margin, Math.min(y, viewportH - height - margin)) };
}

export function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<number>();
  const [subPos, setSubPos] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPos(clampMenu(x, y, box.width, box.height, window.innerWidth, window.innerHeight));
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  }, [x, y]);
  useLayoutEffect(() => {
    if (sub === undefined || !ref.current) { setSubPos(undefined); return; }
    const anchor = ref.current.querySelectorAll<HTMLElement>("[data-index]")[sub]?.getBoundingClientRect();
    const box = subRef.current?.getBoundingClientRect();
    if (!anchor || !box) return;
    const right = anchor.right + 4;
    const left = right + box.width > window.innerWidth - 8 ? anchor.left - box.width - 4 : right;
    setSubPos(clampMenu(left, anchor.top - 6, box.width, box.height, window.innerWidth, window.innerHeight));
  }, [sub, pos]);
  useEffect(() => {
    const down = (event: PointerEvent) => { if (!(event.target instanceof Node) || !(ref.current?.contains(event.target) || subRef.current?.contains(event.target))) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); if (sub !== undefined) { setSub(undefined); focusIndex(ref.current, sub); } else onClose(); } };
    const blur = () => onClose();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", blur);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); window.removeEventListener("resize", blur); window.removeEventListener("blur", blur); };
  }, [onClose, sub]);
  const navigate = (container: HTMLElement | null, event: React.KeyboardEvent, onRight?: () => void, onLeft?: () => void) => {
    const nodes = [...(container?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled]),[role=menuitemradio]:not([disabled])") ?? [])];
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") { event.preventDefault(); nodes[(index + 1) % nodes.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); nodes[(index - 1 + nodes.length) % nodes.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); nodes[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if (event.key === "ArrowRight" && onRight) { event.preventDefault(); onRight(); }
    else if (event.key === "ArrowLeft" && onLeft) { event.preventDefault(); onLeft(); }
  };
  const openSub = (index: number) => { setSub(index); requestAnimationFrame(() => requestAnimationFrame(() => subRef.current?.querySelector<HTMLElement>("[aria-checked=true],[role=menuitemradio]")?.focus())); };
  const submenu = sub !== undefined ? items[sub] : undefined;
  return createPortal(<>
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={pos} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => navigate(ref.current, event, () => { const i = Number((document.activeElement as HTMLElement)?.dataset.index); if (items[i]?.kind === "submenu") openSub(i); })}>
      {items.map((item, index) => item.kind === "separator" ? <div key={index} className="ctx-separator" role="separator" /> :
        <button key={index} type="button" role="menuitem" data-index={index} disabled={item.disabled} title={item.kind === "action" ? item.title : undefined}
          className={`ctx-item${item.kind === "action" && item.danger ? " danger" : ""}${sub === index ? " open" : ""}`}
          aria-haspopup={item.kind === "submenu" ? "menu" : undefined} aria-expanded={item.kind === "submenu" ? sub === index : undefined}
          onPointerEnter={() => setSub(item.kind === "submenu" ? index : undefined)}
          onClick={() => { if (item.kind === "submenu") openSub(index); else { item.onSelect(); onClose(); } }}>
          <span className="ctx-icon">{item.icon}</span><span className="ctx-label">{item.label}</span>{item.kind === "submenu" && <ChevronRight size={14} className="ctx-chevron" />}
        </button>)}
    </div>
    {submenu?.kind === "submenu" && <div ref={subRef} className="ctx-menu ctx-submenu" role="menu" aria-label={submenu.label} style={subPos ?? { left: -9999, top: -9999 }}
      onKeyDown={(event) => navigate(subRef.current, event, undefined, () => { setSub(undefined); focusIndex(ref.current, sub!); })}>
      {submenu.items.map((option) => <button key={option.id ?? "none"} type="button" role="menuitemradio" aria-checked={option.checked}
        className={`ctx-item ctx-tree${option.checked ? " checked" : ""}`} style={{ paddingLeft: 10 + option.depth * 16 }}
        onClick={() => { if (!option.checked) submenu.onPick(option.id); onClose(); }}>
        {option.depth > 0 && <span className="ctx-tree-line" style={{ left: 4 + option.depth * 16 }} aria-hidden="true" />}
        <span className="ctx-icon">{option.folder ? <Folder size={15} /> : <Inbox size={15} />}</span><span className="ctx-label">{option.label}</span>
        <span className="ctx-check">{option.checked && <Check size={15} />}</span>
      </button>)}
      {submenu.items.length === 1 && <p className="ctx-empty">{t("sidebarMenu.noProjects")}</p>}
    </div>}
  </>, document.body);
}

function focusIndex(container: HTMLElement | null, index: number) {
  container?.querySelectorAll<HTMLElement>("[data-index]")[index]?.focus();
}
