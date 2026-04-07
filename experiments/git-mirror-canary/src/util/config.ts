import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CanaryConfig, MirrorRepoConfig } from "./types";

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function positiveInt(value: string | undefined, fallback: number, label: string): number {
  const raw = value?.trim();
  const parsed = Number.parseInt(raw ?? `${fallback}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRepo(entry: unknown): MirrorRepoConfig {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("repo entries must be objects");
  }

  const repo = entry as Record<string, unknown>;
  const id = typeof repo.id === "string" && repo.id.trim() ? repo.id.trim() : "";
  const sourceUrl =
    typeof repo.sourceUrl === "string" && repo.sourceUrl.trim() ? repo.sourceUrl.trim() : "";
  const targetUrl =
    typeof repo.targetUrl === "string" && repo.targetUrl.trim() ? repo.targetUrl.trim() : "";
  const trackedRef =
    typeof repo.trackedRef === "string" && repo.trackedRef.trim()
      ? repo.trackedRef.trim()
      : "refs/heads/main";
  const pollIntervalMs =
    typeof repo.pollIntervalMs === "number" ? Math.trunc(repo.pollIntervalMs) : undefined;

  if (!id || !sourceUrl || !targetUrl) {
    throw new Error("repo entries require id, sourceUrl, and targetUrl");
  }
  if (!trackedRef.startsWith("refs/")) {
    throw new Error(`repo ${id} trackedRef must be a full ref like refs/heads/main`);
  }
  if (pollIntervalMs !== undefined && pollIntervalMs <= 0) {
    throw new Error(`repo ${id} pollIntervalMs must be positive`);
  }

  return {
    id,
    sourceUrl,
    targetUrl,
    trackedRef,
    pollIntervalMs,
  };
}

function parseRepos(env: NodeJS.ProcessEnv, mode: "dev" | "compose"): MirrorRepoConfig[] {
  const inline = optionalString(env.GIT_MIRROR_CANARY_REPOS_JSON);
  const filePath = optionalString(env.GIT_MIRROR_CANARY_REPOS_FILE);
  let raw = inline;

  if (!raw && filePath) {
    raw = readFileSync(filePath, "utf8");
  }

  if (!raw) {
    throw new Error(
      mode === "compose"
        ? "GIT_MIRROR_CANARY_REPOS_FILE or GIT_MIRROR_CANARY_REPOS_JSON is required in compose mode"
        : "Set GIT_MIRROR_CANARY_REPOS_FILE or GIT_MIRROR_CANARY_REPOS_JSON",
    );
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("repo config must be a non-empty JSON array");
  }
  return parsed.map((entry) => normalizeRepo(entry));
}

function loadDevConfig(env: NodeJS.ProcessEnv): CanaryConfig {
  const port = positiveInt(env.GIT_MIRROR_CANARY_PORT, 4080, "GIT_MIRROR_CANARY_PORT");
  const hostname = env.GIT_MIRROR_CANARY_HOST?.trim() || "127.0.0.1";
  const pollIntervalMs = positiveInt(
    env.GIT_MIRROR_CANARY_POLL_INTERVAL_MS,
    300000,
    "GIT_MIRROR_CANARY_POLL_INTERVAL_MS",
  );
  const dataDir = resolve(
    env.GIT_MIRROR_CANARY_DATA_DIR ?? join(process.cwd(), ".git-mirror-canary"),
  );
  const cacheDir = resolve(env.GIT_MIRROR_CANARY_CACHE_DIR ?? join(dataDir, "cache"));
  const stateDbPath = resolve(env.GIT_MIRROR_CANARY_STATE_DB_PATH ?? join(dataDir, "state.sqlite"));

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    mode: "dev",
    hostname,
    port,
    pollIntervalMs,
    dataDir,
    cacheDir,
    stateDbPath,
    repos: parseRepos(env, "dev"),
    eventWebhookUrl: optionalString(env.GIT_MIRROR_CANARY_EVENT_WEBHOOK_URL),
  };
}

function loadComposeConfig(env: NodeJS.ProcessEnv): CanaryConfig {
  const hostname = requiredString(env.GIT_MIRROR_CANARY_HOST, "GIT_MIRROR_CANARY_HOST");
  const port = positiveInt(env.GIT_MIRROR_CANARY_PORT, 4080, "GIT_MIRROR_CANARY_PORT");
  const pollIntervalMs = positiveInt(
    env.GIT_MIRROR_CANARY_POLL_INTERVAL_MS,
    300000,
    "GIT_MIRROR_CANARY_POLL_INTERVAL_MS",
  );
  const dataDir = resolve(
    requiredString(env.GIT_MIRROR_CANARY_DATA_DIR, "GIT_MIRROR_CANARY_DATA_DIR"),
  );
  const cacheDir = resolve(
    requiredString(env.GIT_MIRROR_CANARY_CACHE_DIR, "GIT_MIRROR_CANARY_CACHE_DIR"),
  );
  const stateDbPath = resolve(
    requiredString(env.GIT_MIRROR_CANARY_STATE_DB_PATH, "GIT_MIRROR_CANARY_STATE_DB_PATH"),
  );
  const repos = parseRepos(env, "compose");

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    mode: "compose",
    hostname,
    port,
    pollIntervalMs,
    dataDir,
    cacheDir,
    stateDbPath,
    repos,
    eventWebhookUrl: optionalString(env.GIT_MIRROR_CANARY_EVENT_WEBHOOK_URL),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
  if (env.GIT_MIRROR_CANARY_MODE === "compose") {
    return loadComposeConfig(env);
  }
  return loadDevConfig(env);
}
