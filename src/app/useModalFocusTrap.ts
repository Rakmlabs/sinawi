import { useEffect } from "react";
import { terminalOwnsKeyboardEvent } from "../terminal-events";

/** While a `.modal` is open: Escape closes it, Tab cycles inside it, focus returns on close. */
export function useModalFocusTrap(modal: string | undefined, close: () => void) {
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const handle = (e: KeyboardEvent) => {
      if (terminalOwnsKeyboardEvent(e)) return;
      if (e.defaultPrevented) return;
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not(:disabled), .modal input:not(:disabled), .modal textarea:not(:disabled)",
          ),
        ).filter((element) => element.tabIndex >= 0);
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    document.querySelector<HTMLElement>(".modal button")?.focus();
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
    // `close` is a state setter wrapper; only the modal identity re-arms the trap (as before).
  }, [modal]);
}
