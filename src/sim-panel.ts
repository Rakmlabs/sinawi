/** Pure helpers for the simulator panel (SimulatorPanel.tsx). */

export type SimDevice = { udid: string; name: string; runtime: string; booted: boolean };
/** What the panel posts to /api/sim-view/input. A drag is a down, any number of moves and an up; points are 0–1 fractions of the screen. */
export type SimInput =
  | { kind: "tap" | "down" | "move" | "up"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

export const SIM_DEVICE_STORE = "orchestra.sim.device";
/** Window event the app fires to show the simulator window (header button or an agent's ao-sim launch). */
export const SIM_OPEN_EVENT = "orchestra:sim-open";

/** A press that has moved this far (CSS pixels) is a drag (scroll, swipe back); one that barely moves stays a tap. */
export const TAP_SLOP = 8;
export function pastTap(start: { x: number; y: number }, point: { x: number; y: number }, size: { width: number; height: number }): boolean {
  return Math.hypot((point.x - start.x) * size.width, (point.y - start.y) * size.height) >= TAP_SLOP;
}

/**
 * One press on the screen, from pointer down to release: nothing is sent until the pointer passes
 * the tap threshold, then a `down` at the place it was pressed and a `move` for each position after;
 * release sends `up`, or a `tap` when it never got that far.
 */
export function pressTracker(start: { x: number; y: number }, emit: (input: SimInput) => void) {
  let dragging = false, last = start;
  return {
    move(point: { x: number; y: number }, size: { width: number; height: number }) {
      if (!dragging) {
        if (!pastTap(start, point, size)) return;
        dragging = true;
        emit({ kind: "down", ...start });
      }
      last = point;
      emit({ kind: "move", ...point });
    },
    /** `point` is where the pointer was released; a cancelled press passes nothing and lifts where it last was. */
    end(point?: { x: number; y: number }) {
      if (dragging) emit({ kind: "up", ...(point ?? last) });
      else if (point) emit({ kind: "tap", ...start });
    },
  };
}

/**
 * Posts inputs one request at a time, in the order given, so a down can never overtake a move.
 * This is also the throttle: while a request is in flight only the newest move waits behind it,
 * so moves go out as fast as the simulator takes them and never queue up stale positions.
 */
export function inputSender(post: (input: SimInput) => Promise<unknown>, onError: (error: unknown) => void = () => undefined) {
  const queue: SimInput[] = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    for (let next = queue.shift(); next; next = queue.shift()) {
      try { await post(next); } catch (error) { onError(error); }
    }
    busy = false;
  };
  return (input: SimInput) => {
    if (input.kind === "move" && queue.at(-1)?.kind === "move") queue[queue.length - 1] = input;
    else queue.push(input);
    void pump();
  };
}

/** A point clamped onto the shown frame, as fractions: a drag that leaves the screen ends at its edge. */
export function clampedIn(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return rect.width > 0 && rect.height > 0 ? { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height) } : { x: 0, y: 0 };
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
