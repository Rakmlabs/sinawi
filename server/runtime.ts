import { dirname, resolve } from "node:path";

/** Reads `SINAWI_<name>`, falling back to the pre-rename `AGENT_ORCHESTRA_<name>` so existing setups keep working. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`SINAWI_${name}`] || env[`AGENT_ORCHESTRA_${name}`] || undefined;
}

/** Packaged apps keep mutable data outside the signed application bundle. */
export const defaultDataDir = resolve(envVar("DATA_DIR") || resolve(process.cwd(), ".data"));

/** The data folder: the one given, else SINAWI_DATA_DIR, else `./.data` (the same rule the stores use). */
export function dataDirFor(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dataDir || envVar("DATA_DIR", env) || defaultDataDir);
}

function positiveFinite(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeOptions(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const production = args.includes("start");
  return {
    dataDir: dataDirFor(undefined, env),
    inactivityTimeoutMs: positiveFinite(envVar("INACTIVITY_TIMEOUT_MS", env), 10 * 60 * 1_000),
    ...(production ? {
      staticDir: resolve(envVar("STATIC_DIR", env) || resolve(dirname(process.argv[1]), "dist")),
    } : {}),
  };
}

/** The port the app and a plain `npm run dev` use. */
export const DEFAULT_PORT = 3001;

/**
 * A second copy next to the app (another port, or SINAWI_ISOLATED=1) keeps to its own data folder: it
 * does not watch the shared browser/computer/serve queues in /tmp (it would take the app's commands)
 * nor rewrite ~/.local/bin/ao-* and the CLIs' skills in the home folder (review L6).
 */
export function isolatedRun(port: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = envVar("ISOLATED", env);
  if (flag === "0") return false;
  return flag === "1" || port !== DEFAULT_PORT;
}
