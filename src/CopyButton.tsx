import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { t } from "./i18n";

type ClipboardWriter = { writeText: (text: string) => Promise<void> };
type CopyState = "idle" | "copied" | "error";

export async function writeClipboard(text: string, clipboard: ClipboardWriter | null | undefined): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, ariaLabel, className, showLabel = false }: {
  text: string;
  ariaLabel: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const label = state === "copied" ? t("copy.copied") : state === "error" ? t("copy.failed") : t("copy.copy");
  const copy = async () => {
    let clipboard: ClipboardWriter | undefined;
    try { clipboard = navigator.clipboard; } catch { clipboard = undefined; }
    setState(await writeClipboard(text, clipboard) ? "copied" : "error");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1_800);
  };
  return <>
    <button type="button" className={className} aria-label={ariaLabel} title={state === "error" ? t("copy.clipboardError") : ariaLabel} onClick={() => void copy()}>
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}{showLabel && label}
    </button>
    <span className="sr-only" role="status" aria-live="polite">{state === "idle" ? "" : label}</span>
  </>;
}
