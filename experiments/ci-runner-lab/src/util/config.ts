import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerConfig } from "./types";

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

function loadDevConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const dataDir = resolve(env.CI_RUNNER_LAB_DATA_DIR ?? join(process.cwd(), ".ci-runner-lab"));
  const workDir = resolve(env.CI_RUNNER_LAB_WORK_DIR ?? join(dataDir, "work"));
  const runsFile = resolve(env.CI_RUNNER_LAB_RUNS_FILE ?? join(dataDir, "runs.json"));

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  return {
    mode: "dev",
    hostname: env.CI_RUNNER_LAB_HOST?.trim() || "127.0.0.1",
    port: positiveInt(env.CI_RUNNER_LAB_PORT, 4091, "CI_RUNNER_LAB_PORT"),
    dataDir,
    runsFile,
    workDir,
    maxConcurrentRuns: positiveInt(
      env.CI_RUNNER_LAB_MAX_CONCURRENT_RUNS,
      2,
      "CI_RUNNER_LAB_MAX_CONCURRENT_RUNS",
    ),
    stepTimeoutMs: positiveInt(
      env.CI_RUNNER_LAB_STEP_TIMEOUT_MS,
      300000,
      "CI_RUNNER_LAB_STEP_TIMEOUT_MS",
    ),
  };
}

function loadComposeConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const dataDir = resolve(requiredString(env.CI_RUNNER_LAB_DATA_DIR, "CI_RUNNER_LAB_DATA_DIR"));
  const workDir = resolve(requiredString(env.CI_RUNNER_LAB_WORK_DIR, "CI_RUNNER_LAB_WORK_DIR"));
  const runsFile = resolve(requiredString(env.CI_RUNNER_LAB_RUNS_FILE, "CI_RUNNER_LAB_RUNS_FILE"));

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  return {
    mode: "compose",
    hostname: requiredString(env.CI_RUNNER_LAB_HOST, "CI_RUNNER_LAB_HOST"),
    port: positiveInt(env.CI_RUNNER_LAB_PORT, 4091, "CI_RUNNER_LAB_PORT"),
    dataDir,
    runsFile,
    workDir,
    maxConcurrentRuns: positiveInt(
      env.CI_RUNNER_LAB_MAX_CONCURRENT_RUNS,
      2,
      "CI_RUNNER_LAB_MAX_CONCURRENT_RUNS",
    ),
    stepTimeoutMs: positiveInt(
      env.CI_RUNNER_LAB_STEP_TIMEOUT_MS,
      300000,
      "CI_RUNNER_LAB_STEP_TIMEOUT_MS",
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if (env.CI_RUNNER_LAB_MODE === "compose") {
    return loadComposeConfig(env);
  }
  return loadDevConfig(env);
}
