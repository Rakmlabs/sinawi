/** Pure helpers for the simulator panel (SimulatorPanel.tsx). */

export type SimDevice = { udid: string; name: string; runtime: string; booted: boolean };
export type SimGesture = { kind: "tap"; x: number; y: number } | { kind: "drag"; x1: number; y1: number; x2: number; y2: number; duration: number };

export const SIM_DEVICE_STORE = "orchestra.sim.device";
/** Window event the app fires to show the simulator window (header button or an agent's ao-sim launch). */
export const SIM_OPEN_EVENT = "orchestra:sim-open";

/** A press that barely moves is a tap; anything else is a drag (scroll, swipe back). Points are 0–1 fractions of the screen. */
export function gesture(start: { x: number; y: number; t: number }, end: { x: number; y: number; t: number }, size: { width: number; height: number }): SimGesture {
  const moved = Math.hypot((end.x - start.x) * size.width, (end.y - start.y) * size.height);
  if (moved < 8) return { kind: "tap", x: start.x, y: start.y };
  return { kind: "drag", x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: Math.min(2, Math.max(0.1, (end.t - start.t) / 1000)) };
}

/** Where a pointer lands on the shown frame, as fractions, or undefined outside it. */
export function fractionIn(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? undefined : { x, y };
}

/** The device to show: the remembered one if it still exists, else the first booted, else the first. */
export function pickDevice(devices: SimDevice[], remembered: string | null): SimDevice | undefined {
  return devices.find((device) => device.udid === remembered) ?? devices.find((device) => device.booted) ?? devices[0];
}

/** Keys the panel sends as key presses rather than text. */
export function specialKey(key: string): "enter" | "backspace" | "tab" | undefined {
  return key === "Enter" ? "enter" : key === "Backspace" ? "backspace" : key === "Tab" ? "tab" : undefined;
}
