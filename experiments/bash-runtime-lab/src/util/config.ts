import { resolve } from "node:path";
import type { AppMode, BashRuntimeConfig } from "./types";

function readMode(env: NodeJS.ProcessEnv): AppMode {
  return env.BASH_RUNTIME_LAB_MODE === "compose" ? "compose" : "dev";
}

function readString(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string | undefined,
  mode: AppMode,
): string {
  const value = env[key]?.trim();
  if (value) {
    return value;
  }

  if (mode === "compose" || fallback === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return fallback;
}

function readPort(env: NodeJS.ProcessEnv, mode: AppMode): number {
  const raw = readString(env, "BASH_RUNTIME_LAB_PORT", "4093", mode);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid BASH_RUNTIME_LAB_PORT: ${raw}`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BashRuntimeConfig {
  const mode = readMode(env);
  const dataDir = resolve(
    readString(env, "BASH_RUNTIME_LAB_DATA_DIR", mode === "compose" ? undefined : "./data", mode),
  );

  return {
    mode,
    host: readString(
      env,
      "BASH_RUNTIME_LAB_HOST",
      mode === "compose" ? undefined : "127.0.0.1",
      mode,
    ),
    port: readPort(env, mode),
    dataDir,
    runsDir: resolve(dataDir, "runs"),
    workspacesDir: resolve(dataDir, "workspaces"),
  };
}
