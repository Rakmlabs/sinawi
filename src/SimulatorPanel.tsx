import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Power, RefreshCw } from "lucide-react";
import type { ComposerAttachment } from "./preview-attachments";
import { fractionIn, gesture, pickDevice, SIM_DEVICE_STORE, SIM_OPEN_EVENT, specialKey, type SimDevice, type SimGesture } from "./sim-panel";
import { t } from "./i18n";
import "./simulator.css";

type Props = { open: boolean; onAttach: (items: ComposerAttachment[]) => void };

const readStore = () => { try { return localStorage.getItem(SIM_DEVICE_STORE); } catch { return null; } };

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/sim-view/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as { error?: string; path?: string };
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/**
 * A booted iOS simulator inside Sinawi: the live screen (polled frames from the server's AXe
 * stream), clicks and drags forwarded as touches, and typing forwarded through a hidden input so
 * Korean IME composition finishes before it is sent.
 */
export function SimulatorPanel({ open, onAttach }: Props) {
  const [devices, setDevices] = useState<SimDevice[]>([]);
  const [udid, setUdid] = useState<string | null>(readStore);
  const [frameUrl, setFrameUrl] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const screen = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLInputElement>(null);
  const press = useRef<{ x: number; y: number; t: number } | undefined>(undefined);
  const device = devices.find((item) => item.udid === udid);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sim-view/devices");
      const data = await res.json() as { devices?: SimDevice[]; error?: string };
      if (!res.ok) throw new Error(data.error || res.statusText);
      const list = data.devices ?? [];
      setDevices(list);
      setUdid((current) => pickDevice(list, current)?.udid ?? null);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // An agent's `ao-sim launch` names the device it used; follow it.
  useEffect(() => {
    const follow = (event: Event) => {
      const next = (event as CustomEvent<{ udid?: string }>).detail?.udid;
      if (next) { setUdid(next); void refresh(); }
    };
    window.addEventListener(SIM_OPEN_EVENT, follow);
    return () => window.removeEventListener(SIM_OPEN_EVENT, follow);
  }, [refresh]);
  useEffect(() => { try { if (udid) localStorage.setItem(SIM_DEVICE_STORE, udid); } catch { /* private mode */ } }, [udid]);

  // Frame loop: ask for anything newer than the last frame while the window is visible.
  useEffect(() => {
    if (!open || !device?.booted) return;
    let stopped = false, seq = "", url: string | undefined;
    const loop = async () => {
      while (!stopped) {
        let wait = 70;
        try {
          const res = await fetch(`/api/sim-view/frame?udid=${encodeURIComponent(device.udid)}&after=${seq}`, { cache: "no-store" });
          if (res.status === 200) {
            seq = res.headers.get("X-Frame-Seq") ?? "";
            const next = URL.createObjectURL(await res.blob());
            if (stopped) { URL.revokeObjectURL(next); break; }
            setFrameUrl(next);
            if (url) URL.revokeObjectURL(url);
            url = next;
            setError("");
          } else if (res.status !== 204) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            setError(data.error || res.statusText);
            wait = 2_000;
          }
        } catch { wait = 1_000; }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    };
    void loop();
    return () => { stopped = true; if (url) URL.revokeObjectURL(url); setFrameUrl(undefined); };
  }, [open, device?.udid, device?.booted]);

  const send = useCallback((body: Record<string, unknown>) => {
    if (!device) return;
    void post("input", { udid: device.udid, ...body }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [device]);

  const at = (event: React.PointerEvent) => (screen.current ? fractionIn(screen.current.getBoundingClientRect(), event.clientX, event.clientY) : undefined);
  const down = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const point = at(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    press.current = { ...point, t: performance.now() };
    keys.current?.focus({ preventScroll: true });
  };
  const up = (event: React.PointerEvent) => {
    const start = press.current;
    press.current = undefined;
    if (!start || !screen.current) return;
    const rect = screen.current.getBoundingClientRect();
    const end = { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)), t: performance.now() };
    const move: SimGesture = gesture(start, end, rect);
    send(move);
  };

  const boot = async () => {
    if (!device) return;
    setBusy(true);
    try { await post("boot", { udid: device.udid }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const attach = async () => {
    if (!device) return;
    try {
      const { path } = await post("capture", { udid: device.udid });
      onAttach([{ id: `sim-${Date.now()}`, kind: "image", label: `${device.name} 화면`, screenshotPath: path, preview: frameUrl }]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="sim-panel" aria-label={t("sim.label")}>
      <div className="sim-toolbar">
        <select className="sim-device" value={udid ?? ""} onChange={(event) => setUdid(event.target.value)} aria-label={t("sim.device")}>
          {devices.map((item) => <option key={item.udid} value={item.udid}>{item.name} · {item.runtime}{item.booted ? "" : ` (${t("sim.off")})`}</option>)}
        </select>
        <button type="button" className="browser-icon" onClick={() => void refresh()} aria-label={t("sim.refresh")} title={t("sim.refresh")}><RefreshCw size={15} /></button>
        <button type="button" className="browser-icon" onClick={() => void attach()} disabled={!device?.booted} aria-label={t("sim.attach")} title={t("sim.attach")}><Camera size={15} /></button>
      </div>
      <div className="sim-stage" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { press.current = undefined; }}>
        {device && !device.booted ? (
          <div className="sim-empty"><p>{t("sim.offHint", { name: device.name })}</p><button type="button" className="sim-boot" onClick={() => void boot()} disabled={busy}><Power size={15} />{busy ? t("sim.booting") : t("sim.boot")}</button></div>
        ) : !devices.length ? (
          <div className="sim-empty"><p>{error || t("sim.none")}</p></div>
        ) : frameUrl ? (
          <img ref={screen} className="sim-screen" src={frameUrl} alt={t("sim.screen")} draggable={false} />
        ) : (
          <div className="sim-empty"><p>{error || t("sim.loading")}</p></div>
        )}
        <input ref={keys} className="sim-keys" aria-label={t("sim.keys")} autoComplete="off" autoCorrect="off" spellCheck={false}
          onKeyDown={(event) => {
            const key = specialKey(event.key);
            if (!key || event.nativeEvent.isComposing || event.currentTarget.value) return;
            event.preventDefault();
            send({ kind: "key", key });
          }}
          onInput={(event) => {
            const input = event.currentTarget;
            if ((event.nativeEvent as InputEvent).isComposing || !input.value) return;
            send({ kind: "type", text: input.value });
            input.value = "";
          }}
          onCompositionEnd={(event) => {
            const input = event.currentTarget;
            if (input.value) { send({ kind: "type", text: input.value }); input.value = ""; }
          }} />
      </div>
      {error && frameUrl && <p className="sim-error" role="status">{error}</p>}
      <p className="sim-hint">{t("sim.hint")}</p>
    </div>
  );
}
