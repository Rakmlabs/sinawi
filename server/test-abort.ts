// For tests' fake CLI runners: run `then` once the run's signal is aborted, also when it was aborted
// before the runner got to listen. A listener added to an already-aborted signal never fires, and a
// short watchdog (20 ms) can abort before the runner is called on a loaded machine: the fake then
// waited forever while the real runner (cli.ts runCli) checks `signal.aborted` too (third review N5).
export function onAbort(signal: AbortSignal | undefined, then: () => void): void {
  if (!signal) return;
  if (signal.aborted) { then(); return; }
  signal.addEventListener("abort", then, { once: true });
}

/** Resolves once the signal is aborted (at once when it already is). */
export const whenAborted = (signal: AbortSignal | undefined) => new Promise<void>((resolve) => onAbort(signal, resolve));
