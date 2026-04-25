import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CompletePayload } from "./schema";
import { findRepoRoot, resolveMemoryDir } from "./memory";
import type { WideEvent } from "./wide-events";

const RUN_HISTORY_VERSION = 2;
const RUN_HISTORY_LIMIT = 100;
const DEFAULT_MEMORY_PREFIX = "daemon-memory/v1";

export type DaemonRunRecord = {
  version: typeof RUN_HISTORY_VERSION;
  daemon: string;
  repoId: string;
  repoRoot: string;
  scopeRoot: string;
  file: string;
  runId: string;
  provider: string;
  systemPrompt?: string;
  input: string | null;
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed";
  turns: number;
  tokens: { input: number; output: number };
  payload?: CompletePayload;
  failure?: {
    reason: "turn_budget_exceeded" | "wallclock_exceeded" | "provider_error";
    message: string;
  };
  events: WideEvent[];
};

export type DaemonRunIndexEntry = {
  runId: string;
  daemon: string;
  commit: string | null;
  provider: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed";
  turns: number;
  tokens: { input: number; output: number };
  summary?: string;
  findingCount?: number;
  reason?: "turn_budget_exceeded" | "wallclock_exceeded" | "provider_error";
  message?: string;
};

export type DaemonRunIndex = {
  version: typeof RUN_HISTORY_VERSION;
  daemon: string;
  repoId: string;
  updatedAt: string;
  recentRuns: DaemonRunIndexEntry[];
};

type RunHistoryBackend = {
  loadIndex(daemonName: string): Promise<DaemonRunIndex | null>;
  saveIndex(index: DaemonRunIndex): Promise<void>;
  loadRun(daemonName: string, runId: string): Promise<DaemonRunRecord | null>;
  saveRun(record: DaemonRunRecord): Promise<string>;
};

export async function saveDaemonRun(
  record: Omit<DaemonRunRecord, "version" | "repoId" | "repoRoot" | "commit">,
  scopeRoot: string,
  explicitDir?: string,
): Promise<string> {
  const repoRoot = await findRepoRoot(scopeRoot);
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  const repoId = await inferRepoId(repoRoot);
  const commit = await getCurrentCommit(repoRoot);
  const backend = createRunHistoryBackend(memoryDir, repoId);
  const normalized: DaemonRunRecord = {
    ...record,
    version: RUN_HISTORY_VERSION,
    repoId,
    repoRoot,
    scopeRoot,
    commit,
  };
  const location = await backend.saveRun(normalized);
  const existing =
    (await backend.loadIndex(normalized.daemon)) ??
    createEmptyRunIndex(normalized.daemon, normalized.repoId);
  const entry = createIndexEntry(normalized);
  await backend.saveIndex({
    ...existing,
    updatedAt: normalized.finishedAt,
    recentRuns: [
      entry,
      ...existing.recentRuns.filter((candidate) => candidate.runId !== entry.runId),
    ].slice(0, RUN_HISTORY_LIMIT),
  });
  return location;
}

export async function loadDaemonRun(
  daemonName: string,
  scopeRoot: string,
  runId: string,
  explicitDir?: string,
): Promise<DaemonRunRecord | null> {
  const repoRoot = await findRepoRoot(scopeRoot);
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  const repoId = await inferRepoId(repoRoot);
  const backend = createRunHistoryBackend(memoryDir, repoId);
  return backend.loadRun(daemonName, runId);
}

export async function listDaemonRuns(
  daemonName: string,
  scopeRoot: string,
  explicitDir?: string,
): Promise<DaemonRunIndexEntry[]> {
  const repoRoot = await findRepoRoot(scopeRoot);
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  const repoId = await inferRepoId(repoRoot);
  const backend = createRunHistoryBackend(memoryDir, repoId);
  const index = await backend.loadIndex(daemonName);
  return index?.recentRuns ?? [];
}

function createEmptyRunIndex(daemon: string, repoId: string): DaemonRunIndex {
  return {
    version: RUN_HISTORY_VERSION,
    daemon,
    repoId,
    updatedAt: new Date(0).toISOString(),
    recentRuns: [],
  };
}

function createIndexEntry(record: DaemonRunRecord): DaemonRunIndexEntry {
  return {
    runId: record.runId,
    daemon: record.daemon,
    commit: record.commit,
    provider: record.provider,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    turns: record.turns,
    tokens: record.tokens,
    summary: record.payload?.summary,
    findingCount: record.payload?.findings.length,
    reason: record.failure?.reason,
    message: record.failure?.message,
  };
}

function createRunHistoryBackend(memoryDir: string, repoId: string): RunHistoryBackend {
  if ((process.env.AI_DAEMONS_MEMORY_BACKEND ?? "local") === "r2") {
    return createR2RunHistoryBackend(repoId);
  }
  return createLocalRunHistoryBackend(memoryDir, repoId);
}

function createLocalRunHistoryBackend(memoryDir: string, repoId: string): RunHistoryBackend {
  function daemonRoot(daemonName: string): string {
    return join(memoryDir, "v1", ...repoId.split("/"), daemonName, "runs");
  }

  function indexPath(daemonName: string): string {
    return join(daemonRoot(daemonName), "index.json");
  }

  function runPath(daemonName: string, runId: string): string {
    return join(daemonRoot(daemonName), `${runId}.json`);
  }

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async function writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  return {
    loadIndex(daemonName) {
      return readJson<DaemonRunIndex>(indexPath(daemonName));
    },
    saveIndex(index) {
      return writeJson(indexPath(index.daemon), index);
    },
    loadRun(daemonName, runId) {
      return readJson<DaemonRunRecord>(runPath(daemonName, runId));
    },
    async saveRun(record) {
      const path = runPath(record.daemon, record.runId);
      await writeJson(path, record);
      return path;
    },
  };
}

function createR2RunHistoryBackend(repoId: string): RunHistoryBackend {
  const bucket = process.env.AI_DAEMONS_R2_BUCKET;
  const endpoint =
    process.env.AI_DAEMONS_R2_ENDPOINT ??
    (process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  const accessKeyId = process.env.AI_DAEMONS_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AI_DAEMONS_R2_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("missing AI_DAEMONS_R2_* environment for R2 daemon memory backend");
  }

  const client = new S3Client({
    region: process.env.AI_DAEMONS_R2_REGION ?? "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
  const prefix = (process.env.AI_DAEMONS_MEMORY_PREFIX ?? DEFAULT_MEMORY_PREFIX).replace(/\/+$/, "");

  function keyForDaemon(daemonName: string, suffix: string): string {
    return `${prefix}/${repoId}/${daemonName}/runs/${suffix}`;
  }

  async function getJson<T>(key: string): Promise<T | null> {
    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      const body = await response.Body?.transformToString();
      return body ? (JSON.parse(body) as T) : null;
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async function putJson(key: string, value: unknown): Promise<void> {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(value, null, 2),
        ContentType: "application/json",
      }),
    );
  }

  return {
    loadIndex(daemonName) {
      return getJson<DaemonRunIndex>(keyForDaemon(daemonName, "index.json"));
    },
    saveIndex(index) {
      return putJson(keyForDaemon(index.daemon, "index.json"), index);
    },
    loadRun(daemonName, runId) {
      return getJson<DaemonRunRecord>(keyForDaemon(daemonName, `${runId}.json`));
    },
    async saveRun(record) {
      const key = keyForDaemon(record.daemon, `${record.runId}.json`);
      await putJson(key, record);
      return key;
    },
  };
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const parsed = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    parsed.name === "NoSuchKey" ||
    parsed.Code === "NoSuchKey" ||
    parsed.$metadata?.httpStatusCode === 404
  );
}

function parseRepoIdFromRemote(remote: string): string | null {
  if (!remote) return null;
  const cleaned = remote.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/[:/]([^/:]+\/[^/]+)$/);
  return sshMatch?.[1] ?? null;
}

async function inferRepoId(repoRoot: string): Promise<string> {
  const explicit = process.env.AI_DAEMONS_MEMORY_REPO ?? process.env.REPO;
  if (explicit) return explicit;
  const remote = await runGit(repoRoot, ["remote", "get-url", "origin"]);
  if (remote.ok) {
    const parsed = parseRepoIdFromRemote(remote.stdout.trim());
    if (parsed) return parsed;
  }
  return basename(repoRoot);
}

async function getCurrentCommit(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  const proc = Bun.spawn({
    cmd: ["git", "-C", cwd, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stderr };
}
