import { dirname, resolve } from "node:path";

/** Packaged apps keep mutable data outside the signed application bundle. */
export const defaultDataDir = resolve(process.env.AGENT_ORCHESTRA_DATA_DIR || resolve(process.cwd(), ".data"));

function positiveFinite(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeOptions(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const production = args.includes("start");
  return {
    dataDir: defaultDataDir,
    inactivityTimeoutMs: positiveFinite(env.AGENT_ORCHESTRA_INACTIVITY_TIMEOUT_MS, 10 * 60 * 1_000),
    ...(production ? {
      staticDir: resolve(env.AGENT_ORCHESTRA_STATIC_DIR || resolve(dirname(process.argv[1]), "dist")),
    } : {}),
  };
}
