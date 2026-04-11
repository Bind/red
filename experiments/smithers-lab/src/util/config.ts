import { dirname, resolve } from "node:path";

export type AppMode = "dev" | "compose";

export type AppConfig = {
  mode: AppMode;
  hostname: string;
  port: number;
  dbPath: string;
  dataDir: string;
  openaiModel: string;
  allowNetwork: boolean;
};

function readMode(): AppMode {
  const value = process.env.SMITHERS_LAB_MODE;
  return value === "compose" ? "compose" : "dev";
}

function readString(key: string, fallback: string | undefined, mode: AppMode): string {
  const value = process.env[key]?.trim();
  if (value) {
    return value;
  }

  if (mode === "compose" || fallback === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return fallback;
}

function readPort(mode: AppMode): number {
  const value = readString("SMITHERS_LAB_PORT", "4090", mode);
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid SMITHERS_LAB_PORT: ${value}`);
  }
  return port;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim();
  if (!value) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const previousEnv = process.env;
  process.env = env;

  try {
    const mode = readMode();
    const hostname = readString(
      "SMITHERS_LAB_HOST",
      mode === "compose" ? undefined : "127.0.0.1",
      mode,
    );
    const port = readPort(mode);
    const dbPath = resolve(
      readString(
        "SMITHERS_LAB_DB_PATH",
        mode === "compose" ? undefined : "./data/smithers-lab.sqlite",
        mode,
      ),
    );

    return {
      mode,
      hostname,
      port,
      dbPath,
      dataDir: dirname(dbPath),
      openaiModel: readString("SMITHERS_LAB_OPENAI_MODEL", "gpt-5-mini", mode),
      allowNetwork: readBoolean("SMITHERS_LAB_ALLOW_NETWORK", false),
    };
  } finally {
    process.env = previousEnv;
  }
}
