import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CompleteFinding } from "./schema";

export const DEFAULT_MEMORY_DIRNAME = ".daemons-cache";
const MEMORY_VERSION = 3;
const DAEMON_CONTRACT_VERSION = 1;
const MEMORY_HISTORY_LIMIT = 200;
const REPO_MARKERS = ["turbo.json", "package.json", ".git"];
const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", DEFAULT_MEMORY_DIRNAME]);
const DEFAULT_MEMORY_PREFIX = "daemon-memory/v1";
const DEFAULT_ANCESTOR_LIMIT = 500;

export type CheckedFileRecord = {
  path: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
};

export type TrackEntry = {
  subject: string;
  fingerprint: string;
  fact: unknown;
  depends_on: string[];
  checked_at: string;
  source_run_id: string;
};

export type DaemonMemoryRecord = {
  version: typeof MEMORY_VERSION;
  daemonContractVersion: number;
  daemon: string;
  scopeRoot: string;
  repoRoot: string;
  repoId: string;
  commit: string | null;
  baseCommit: string | null;
  updatedAt: string;
  tracked: Record<string, TrackEntry>;
  lastRun: {
    summary: string;
    nextRunHint?: string;
    findings: CompleteFinding[];
    checkedFiles: CheckedFileRecord[];
    fileInventory: CheckedFileRecord[];
  };
};

export type DaemonMemorySnapshot = {
  record: DaemonMemoryRecord;
  currentCommit: string | null;
  unchangedFiles: CheckedFileRecord[];
  changedFiles: CheckedFileRecord[];
  missingFiles: CheckedFileRecord[];
  newFiles: CheckedFileRecord[];
  changedScopeFiles: CheckedFileRecord[];
  missingScopeFiles: CheckedFileRecord[];
  staleTrackedSubjects: string[];
};

export type DaemonMemoryStore = {
  readonly daemon: string;
  readonly scopeRoot: string;
  lookup(subjects?: string[]): TrackEntry[];
  record(entry: TrackEntry): Promise<void>;
  invalidate(subjects: string[]): Promise<number>;
  snapshot(): DaemonMemoryRecord;
};

export type DaemonSnapshotIndex = {
  version: typeof MEMORY_VERSION;
  daemonContractVersion: number;
  repoId: string;
  daemon: string;
  updatedAt: string;
  recentCommits: Array<{
    commit: string;
    createdAt: string;
  }>;
};

type MemoryBackend = {
  kind: "local" | "r2";
  loadIndex(daemonName: string): Promise<DaemonSnapshotIndex | null>;
  saveIndex(index: DaemonSnapshotIndex): Promise<void>;
  loadSnapshot(daemonName: string, commit: string): Promise<unknown | null>;
  loadLatest(daemonName: string): Promise<unknown | null>;
  saveSnapshot(record: DaemonMemoryRecord): Promise<string>;
};

type ResolvedMemoryContext = {
  memoryDir: string;
  repoRoot: string;
  repoId: string;
  currentCommit: string | null;
  backend: MemoryBackend;
};

export async function resolveMemoryDir(scopeRoot: string, explicitDir?: string): Promise<string> {
  if (explicitDir) return resolve(explicitDir);
  const envDir = process.env.AI_DAEMONS_MEMORY_DIR;
  if (envDir) return resolve(envDir);

  const repoRoot = await findRepoRoot(scopeRoot);
  return join(repoRoot, DEFAULT_MEMORY_DIRNAME);
}

export async function loadMemorySnapshot(
  daemonName: string,
  scopeRoot: string,
  explicitDir?: string,
): Promise<DaemonMemorySnapshot | null> {
  const ctx = await resolveMemoryContext(scopeRoot, explicitDir);
  const baseRecord = await loadNearestRecord(daemonName, scopeRoot, ctx);
  if (!baseRecord) return null;

  const unchangedFiles: CheckedFileRecord[] = [];
  const changedFiles: CheckedFileRecord[] = [];
  const missingFiles: CheckedFileRecord[] = [];
  const currentInventory = await collectScopeInventory(scopeRoot);
  const previousInventory = new Map(baseRecord.lastRun.fileInventory.map((entry) => [entry.path, entry]));
  const currentInventoryByPath = new Map(currentInventory.map((entry) => [entry.path, entry]));
  const newFiles = currentInventory.filter((entry) => !previousInventory.has(entry.path));
  const changedScopeFiles = currentInventory.filter((entry) => {
    const previous = previousInventory.get(entry.path);
    return previous ? previous.fingerprint !== entry.fingerprint : false;
  });
  const missingScopeFiles = baseRecord.lastRun.fileInventory.filter(
    (entry) => !currentInventoryByPath.has(entry.path),
  );

  for (const checked of baseRecord.lastRun.checkedFiles) {
    const absolute = resolve(scopeRoot, checked.path);
    const current = await fingerprintFile(absolute);
    if (!current) {
      missingFiles.push(checked);
      continue;
    }
    if (current.fingerprint === checked.fingerprint) {
      unchangedFiles.push(checked);
    } else {
      changedFiles.push(checked);
    }
  }

  const staleTrackedSubjects = collectStaleTrackedSubjects(
    baseRecord.tracked,
    scopeRoot,
    previousInventory,
    currentInventoryByPath,
  );

  const activeTracked = Object.fromEntries(
    Object.entries(baseRecord.tracked).filter(([subject]) => !staleTrackedSubjects.includes(subject)),
  );

  return {
    record: {
      ...baseRecord,
      tracked: activeTracked,
    },
    currentCommit: ctx.currentCommit,
    unchangedFiles,
    changedFiles,
    missingFiles,
    newFiles,
    changedScopeFiles,
    missingScopeFiles,
    staleTrackedSubjects,
  };
}

export async function saveMemoryRecord(
  record: DaemonMemoryRecord,
  scopeRoot: string,
  explicitDir?: string,
): Promise<string> {
  const ctx = await resolveMemoryContext(scopeRoot, explicitDir);
  const normalized = normalizeMemoryRecord(
    {
      ...record,
      version: MEMORY_VERSION,
      daemonContractVersion: DAEMON_CONTRACT_VERSION,
      scopeRoot,
      repoRoot: ctx.repoRoot,
      repoId: ctx.repoId,
      commit: record.commit ?? ctx.currentCommit,
      baseCommit: record.baseCommit ?? null,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    },
    record.daemon,
    scopeRoot,
    ctx.repoRoot,
    ctx.repoId,
  );
  if (!normalized) {
    throw new Error(`invalid daemon memory record for ${record.daemon}`);
  }

  const location = await ctx.backend.saveSnapshot(normalized);
  if (normalized.commit) {
    const existing = (await ctx.backend.loadIndex(normalized.daemon)) ?? createEmptyIndex({
      daemon: normalized.daemon,
      repoId: normalized.repoId,
    });
    const recentCommits = [
      { commit: normalized.commit, createdAt: normalized.updatedAt },
      ...existing.recentCommits.filter((entry) => entry.commit !== normalized.commit),
    ].slice(0, MEMORY_HISTORY_LIMIT);
    await ctx.backend.saveIndex({
      ...existing,
      version: MEMORY_VERSION,
      daemonContractVersion: DAEMON_CONTRACT_VERSION,
      updatedAt: normalized.updatedAt,
      recentCommits,
    });
  }
  return location;
}

export async function createDaemonMemoryStore(
  daemonName: string,
  scopeRoot: string,
  explicitDir?: string,
): Promise<DaemonMemoryStore> {
  const existing = await loadMemorySnapshot(daemonName, scopeRoot, explicitDir);
  let state =
    existing?.record ??
    createEmptyMemoryRecord({
      daemon: daemonName,
      scopeRoot,
    });

  return {
    daemon: daemonName,
    scopeRoot,
    lookup(subjects) {
      const entries = Object.values(state.tracked);
      if (!subjects || subjects.length === 0) {
        return entries.sort((a, b) => a.subject.localeCompare(b.subject));
      }
      const wanted = new Set(subjects);
      return entries
        .filter((entry) => wanted.has(entry.subject))
        .sort((a, b) => a.subject.localeCompare(b.subject));
    },
    async record(entry) {
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
        tracked: {
          ...state.tracked,
          [entry.subject]: normalizeTrackEntry(entry),
        },
      };
    },
    async invalidate(subjects) {
      const nextTracked = { ...state.tracked };
      let removed = 0;
      for (const subject of subjects) {
        if (subject in nextTracked) {
          delete nextTracked[subject];
          removed += 1;
        }
      }
      if (removed > 0) {
        state = {
          ...state,
          updatedAt: new Date().toISOString(),
          tracked: nextTracked,
        };
      }
      return removed;
    },
    snapshot() {
      return structuredClone(state);
    },
  };
}

export async function collectCheckedFiles(
  scopeRoot: string,
  relativePaths: Iterable<string>,
): Promise<CheckedFileRecord[]> {
  const unique = new Set<string>();
  const out: CheckedFileRecord[] = [];
  for (const relPath of relativePaths) {
    if (unique.has(relPath)) continue;
    unique.add(relPath);
    const current = await fingerprintFile(resolve(scopeRoot, relPath));
    if (current) out.push({ path: relPath, ...current });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function collectScopeInventory(scopeRoot: string): Promise<CheckedFileRecord[]> {
  const out: CheckedFileRecord[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = join(currentDir, entry.name);
      const rel = normalizeCheckedPath(scopeRoot, absolute);
      if (!rel) continue;
      const current = await fingerprintFile(absolute);
      if (current) out.push({ path: rel, ...current });
    }
  }

  await walk(scopeRoot);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function buildMemoryPrompt(snapshot: DaemonMemorySnapshot | null): string | null {
  if (!snapshot) return null;
  const {
    record,
    currentCommit,
    unchangedFiles,
    changedFiles,
    missingFiles,
    newFiles,
    changedScopeFiles,
    missingScopeFiles,
    staleTrackedSubjects,
  } = snapshot;
  const lines = [
    "Runner-managed memory from the nearest verified commit snapshot is available.",
    "Use it to avoid rereading unchanged files unless another changed contract invalidates that conclusion.",
    "Start with tracked subjects and delta files before broad reads.",
    `Snapshot commit: ${record.commit ?? "uncommitted"}`,
    `Current commit: ${currentCommit ?? "uncommitted"}`,
    `Previous summary: ${record.lastRun.summary}`,
    `Previously checked files: ${record.lastRun.checkedFiles.length}`,
    `Unchanged since snapshot: ${unchangedFiles.length}`,
    `Changed since snapshot: ${changedFiles.length}`,
    `Missing since snapshot: ${missingFiles.length}`,
    `New since snapshot: ${newFiles.length}`,
    `Changed anywhere in scope since snapshot: ${changedScopeFiles.length}`,
    `Stale tracked subjects: ${staleTrackedSubjects.length}`,
  ];

  const previousFindings = record.lastRun.findings.slice(0, 8);
  if (previousFindings.length > 0) {
    lines.push("Previous findings:");
    for (const finding of previousFindings) {
      lines.push(`- ${finding.invariant}: ${finding.status}${finding.target ? ` (${finding.target})` : ""}`);
    }
  }

  const unchangedPreview = unchangedFiles.slice(0, 12).map((f) => f.path);
  if (unchangedPreview.length > 0) {
    lines.push("Previously checked and unchanged:");
    for (const file of unchangedPreview) lines.push(`- ${file}`);
  }

  const changedPreview = changedFiles.slice(0, 12).map((f) => f.path);
  if (changedPreview.length > 0) {
    lines.push("Previously checked but changed:");
    for (const file of changedPreview) lines.push(`- ${file}`);
  }

  const newPreview = newFiles.slice(0, 12).map((f) => f.path);
  if (newPreview.length > 0) {
    lines.push("New files since snapshot:");
    for (const file of newPreview) lines.push(`- ${file}`);
  }

  const changedScopePreview = changedScopeFiles
    .filter((f) => !changedPreview.includes(f.path))
    .slice(0, 12)
    .map((f) => f.path);
  if (changedScopePreview.length > 0) {
    lines.push("Changed files anywhere in scope since snapshot:");
    for (const file of changedScopePreview) lines.push(`- ${file}`);
  }

  const missingPreview = missingFiles.slice(0, 12).map((f) => f.path);
  if (missingPreview.length > 0) {
    lines.push("Previously checked but now missing:");
    for (const file of missingPreview) lines.push(`- ${file}`);
  }

  const missingScopePreview = missingScopeFiles
    .filter((f) => !missingPreview.includes(f.path))
    .slice(0, 12)
    .map((f) => f.path);
  if (missingScopePreview.length > 0) {
    lines.push("Files removed from scope since snapshot:");
    for (const file of missingScopePreview) lines.push(`- ${file}`);
  }

  if (staleTrackedSubjects.length > 0) {
    lines.push("Tracked subjects invalidated since snapshot:");
    for (const subject of staleTrackedSubjects.slice(0, 12)) lines.push(`- ${subject}`);
  }

  if (record.lastRun.nextRunHint) {
    lines.push(`Previous nextRunHint: ${record.lastRun.nextRunHint}`);
  }

  const trackedPreview = Object.values(record.tracked)
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .slice(0, 12);
  if (trackedPreview.length > 0) {
    lines.push("Tracked daemon-local subjects already in memory:");
    for (const entry of trackedPreview) {
      lines.push(`- ${entry.subject} @ ${entry.fingerprint.slice(0, 12)}`);
    }
    lines.push("Use the `track` tool to lookup, record, or invalidate daemon-local facts.");
  }

  return lines.join("\n");
}

export async function findRepoRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  while (true) {
    for (const marker of REPO_MARKERS) {
      try {
        await stat(join(current, marker));
        return current;
      } catch {
        // keep walking upward
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

export function normalizeCheckedPath(scopeRoot: string, rawPath: string): string | null {
  if (!rawPath) return null;
  const absolute = resolve(scopeRoot, rawPath);
  const rel = relative(scopeRoot, absolute);
  if (rel === "" || rel.startsWith("..")) return null;
  return rel;
}

export function createEmptyMemoryRecord(input: {
  daemon: string;
  scopeRoot: string;
  repoRoot?: string;
  repoId?: string;
  commit?: string | null;
  baseCommit?: string | null;
  updatedAt?: string;
}): DaemonMemoryRecord {
  const scopeRoot = resolve(input.scopeRoot);
  return {
    version: MEMORY_VERSION,
    daemonContractVersion: DAEMON_CONTRACT_VERSION,
    daemon: input.daemon,
    scopeRoot,
    repoRoot: input.repoRoot ?? scopeRoot,
    repoId: input.repoId ?? basename(scopeRoot),
    commit: input.commit ?? null,
    baseCommit: input.baseCommit ?? null,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    tracked: {},
    lastRun: {
      summary: "",
      findings: [],
      checkedFiles: [],
      fileInventory: [],
    },
  };
}

function createEmptyIndex(input: { daemon: string; repoId: string }): DaemonSnapshotIndex {
  return {
    version: MEMORY_VERSION,
    daemonContractVersion: DAEMON_CONTRACT_VERSION,
    repoId: input.repoId,
    daemon: input.daemon,
    updatedAt: new Date().toISOString(),
    recentCommits: [],
  };
}

function normalizeMemoryRecord(
  raw: unknown,
  daemonName: string,
  scopeRoot: string,
  repoRoot: string,
  repoId: string,
): DaemonMemoryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<DaemonMemoryRecord> & {
    tracked?: Record<string, unknown>;
    lastRun?: Partial<DaemonMemoryRecord["lastRun"]>;
  };

  const trackedEntries = Object.fromEntries(
    Object.entries(parsed.tracked ?? {}).flatMap(([subject, entry]) => {
      if (!entry || typeof entry !== "object") return [];
      try {
        return [[subject, normalizeTrackEntry({ ...(entry as TrackEntry), subject })]];
      } catch {
        return [];
      }
    }),
  );

  return {
    version: MEMORY_VERSION,
    daemonContractVersion:
      typeof parsed.daemonContractVersion === "number"
        ? parsed.daemonContractVersion
        : DAEMON_CONTRACT_VERSION,
    daemon: parsed.daemon ?? daemonName,
    scopeRoot: parsed.scopeRoot ?? resolve(scopeRoot),
    repoRoot: parsed.repoRoot ?? repoRoot,
    repoId: parsed.repoId ?? repoId,
    commit: parsed.commit ?? null,
    baseCommit: parsed.baseCommit ?? null,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    tracked: trackedEntries,
    lastRun: {
      summary: parsed.lastRun?.summary ?? "",
      nextRunHint: parsed.lastRun?.nextRunHint,
      findings: parsed.lastRun?.findings ?? [],
      checkedFiles: parsed.lastRun?.checkedFiles ?? [],
      fileInventory: parsed.lastRun?.fileInventory ?? [],
    },
  };
}

function normalizeTrackEntry(entry: TrackEntry): TrackEntry {
  return {
    subject: entry.subject,
    fingerprint: entry.fingerprint,
    fact: entry.fact,
    depends_on: [...new Set(entry.depends_on ?? [])].sort(),
    checked_at: entry.checked_at,
    source_run_id: entry.source_run_id,
  };
}

function collectStaleTrackedSubjects(
  tracked: Record<string, TrackEntry>,
  scopeRoot: string,
  previousInventory: Map<string, CheckedFileRecord>,
  currentInventory: Map<string, CheckedFileRecord>,
): string[] {
  const stale = new Set<string>();
  const visiting = new Set<string>();

  function dependencyChanged(dep: string): boolean {
    const normalizedPath = normalizeCheckedPath(scopeRoot, dep);
    if (!normalizedPath) return false;
    const previous = previousInventory.get(normalizedPath);
    const current = currentInventory.get(normalizedPath);
    if (!previous || !current) return true;
    return previous.fingerprint !== current.fingerprint;
  }

  function visit(subject: string): boolean {
    if (stale.has(subject)) return true;
    if (visiting.has(subject)) return false;
    const entry = tracked[subject];
    if (!entry) return true;

    visiting.add(subject);
    for (const dep of entry.depends_on) {
      if (dependencyChanged(dep)) {
        stale.add(subject);
        visiting.delete(subject);
        return true;
      }
      if (dep in tracked && visit(dep)) {
        stale.add(subject);
        visiting.delete(subject);
        return true;
      }
    }
    visiting.delete(subject);
    return false;
  }

  for (const subject of Object.keys(tracked)) visit(subject);
  return [...stale].sort();
}

async function resolveMemoryContext(
  scopeRoot: string,
  explicitDir?: string,
): Promise<ResolvedMemoryContext> {
  const repoRoot = await findRepoRoot(scopeRoot);
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  const repoId = await inferRepoId(repoRoot);
  const currentCommit = await getCurrentCommit(repoRoot);
  const backend = createMemoryBackend(memoryDir, repoId);
  return {
    memoryDir,
    repoRoot,
    repoId,
    currentCommit,
    backend,
  };
}

async function loadNearestRecord(
  daemonName: string,
  scopeRoot: string,
  ctx: ResolvedMemoryContext,
): Promise<DaemonMemoryRecord | null> {
  if (ctx.currentCommit) {
    const index = await ctx.backend.loadIndex(daemonName);
    if (index && index.recentCommits.length > 0) {
      const available = new Set(index.recentCommits.map((entry) => entry.commit));
      const ancestors = await listAncestorCommits(ctx.repoRoot, ctx.currentCommit, DEFAULT_ANCESTOR_LIMIT);
      for (const ancestor of ancestors) {
        if (!available.has(ancestor)) continue;
        const raw = await ctx.backend.loadSnapshot(daemonName, ancestor);
        const normalized = normalizeMemoryRecord(raw, daemonName, scopeRoot, ctx.repoRoot, ctx.repoId);
        if (normalized) return normalized;
      }
    }
  }

  const latest = await ctx.backend.loadLatest(daemonName);
  return normalizeMemoryRecord(latest, daemonName, scopeRoot, ctx.repoRoot, ctx.repoId);
}

function createMemoryBackend(memoryDir: string, repoId: string): MemoryBackend {
  if ((process.env.AI_DAEMONS_MEMORY_BACKEND ?? "local") === "r2") {
    return createR2MemoryBackend(repoId);
  }
  return createLocalMemoryBackend(memoryDir, repoId);
}

function createLocalMemoryBackend(memoryDir: string, repoId: string): MemoryBackend {
  function daemonRoot(daemonName: string): string {
    return join(memoryDir, "v1", ...repoId.split("/"), daemonName);
  }

  function commitsDir(daemonName: string): string {
    return join(daemonRoot(daemonName), "commits");
  }

  function snapshotPath(daemonName: string, commit: string): string {
    return join(commitsDir(daemonName), `${commit}.json`);
  }

  function latestPath(daemonName: string): string {
    return join(daemonRoot(daemonName), "latest.json");
  }

  function indexPath(daemonName: string): string {
    return join(daemonRoot(daemonName), "index.json");
  }

  async function readJson(file: string): Promise<unknown | null> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  }

  return {
    kind: "local",
    loadIndex(daemonName) {
      return readJson(indexPath(daemonName)) as Promise<DaemonSnapshotIndex | null>;
    },
    saveIndex(index) {
      return writeJson(indexPath(index.daemon), index);
    },
    loadSnapshot(daemonName, commit) {
      return readJson(snapshotPath(daemonName, commit));
    },
    loadLatest(daemonName) {
      return readJson(latestPath(daemonName));
    },
    async saveSnapshot(record) {
      if (record.commit) {
        await writeJson(snapshotPath(record.daemon, record.commit), record);
      }
      await writeJson(latestPath(record.daemon), record);
      return record.commit ? snapshotPath(record.daemon, record.commit) : latestPath(record.daemon);
    },
  };
}

function createR2MemoryBackend(repoId: string): MemoryBackend {
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
    return `${prefix}/${repoId}/${daemonName}/${suffix}`;
  }

  async function getJson(key: string): Promise<unknown | null> {
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : null;
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
    kind: "r2",
    loadIndex(daemonName) {
      return getJson(keyForDaemon(daemonName, "index.json")) as Promise<DaemonSnapshotIndex | null>;
    },
    saveIndex(index) {
      return putJson(keyForDaemon(index.daemon, "index.json"), index);
    },
    loadSnapshot(daemonName, commit) {
      return getJson(keyForDaemon(daemonName, `commits/${commit}.json`));
    },
    loadLatest(daemonName) {
      return getJson(keyForDaemon(daemonName, "latest.json"));
    },
    async saveSnapshot(record) {
      if (record.commit) {
        await putJson(keyForDaemon(record.daemon, `commits/${record.commit}.json`), record);
      }
      await putJson(keyForDaemon(record.daemon, "latest.json"), record);
      return keyForDaemon(
        record.daemon,
        record.commit ? `commits/${record.commit}.json` : "latest.json",
      );
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

function parseRepoIdFromRemote(remote: string): string | null {
  if (!remote) return null;
  const cleaned = remote.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/[:/]([^/:]+\/[^/]+)$/);
  return sshMatch?.[1] ?? null;
}

async function getCurrentCommit(repoRoot: string): Promise<string | null> {
  const res = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return res.ok ? res.stdout.trim() : null;
}

async function listAncestorCommits(
  repoRoot: string,
  headCommit: string,
  limit: number,
): Promise<string[]> {
  const res = await runGit(repoRoot, ["rev-list", `--max-count=${limit}`, headCommit]);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

async function fingerprintFile(
  absolutePath: string,
): Promise<{ fingerprint: string; size: number; mtimeMs: number } | null> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return null;
    const content = await readFile(absolutePath);
    return {
      fingerprint: createHash("sha256").update(content).digest("hex"),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}
