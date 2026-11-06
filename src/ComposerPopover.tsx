import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";

/** Keep slash suggestions outside the conversation's scrolling and glass layers. */
export function ComposerPopover({ anchor, children }: { anchor: RefObject<HTMLTextAreaElement | null>; children: ReactNode }) {
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number }>();
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(rect.width, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: Math.max(12, window.innerHeight - rect.top + 8), width, maxHeight: Math.max(60, Math.min(280, rect.top - 24)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);
  return position ? createPortal(<div className="slash-popup composer-popover" style={position} id="slash-skills" role="listbox" aria-label={t("composer.completionListLabel")}>{children}</div>, document.body) : null;
}
