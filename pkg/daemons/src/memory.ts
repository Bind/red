import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { CompleteFinding } from "./schema";

export const DEFAULT_MEMORY_DIRNAME = ".daemons-cache";
const MEMORY_VERSION = 2;
const REPO_MARKERS = ["turbo.json", "package.json", ".git"];
const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", DEFAULT_MEMORY_DIRNAME]);

export type CheckedFileRecord = {
  path: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
};

export type DaemonMemoryRecord = {
  version: typeof MEMORY_VERSION;
  daemon: string;
  scopeRoot: string;
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

export type TrackEntry = {
  subject: string;
  fingerprint: string;
  fact: unknown;
  depends_on: string[];
  checked_at: string;
  source_run_id: string;
};

export type DaemonMemorySnapshot = {
  record: DaemonMemoryRecord;
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

export async function resolveMemoryDir(scopeRoot: string, explicitDir?: string): Promise<string> {
  if (explicitDir) return resolve(explicitDir);
  const envDir = process.env.AI_DAEMONS_MEMORY_DIR;
  if (envDir) return resolve(envDir);

  const repoRoot = await findRepoRoot(scopeRoot);
  return join(repoRoot, DEFAULT_MEMORY_DIRNAME);
}

export function memoryFilePath(memoryDir: string, daemonName: string): string {
  return join(memoryDir, `${daemonName}.json`);
}

export async function loadMemorySnapshot(
  daemonName: string,
  scopeRoot: string,
  explicitDir?: string,
): Promise<DaemonMemorySnapshot | null> {
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  const file = memoryFilePath(memoryDir, daemonName);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw) as DaemonMemoryRecord;
  const normalized = normalizeMemoryRecord(parsed, daemonName, scopeRoot);
  if (!normalized) return null;

  const unchangedFiles: CheckedFileRecord[] = [];
  const changedFiles: CheckedFileRecord[] = [];
  const missingFiles: CheckedFileRecord[] = [];
  const currentInventory = await collectScopeInventory(scopeRoot);
  const previousInventory = new Map(
    normalized.lastRun.fileInventory.map((entry) => [entry.path, entry]),
  );
  const currentInventoryByPath = new Map(currentInventory.map((entry) => [entry.path, entry]));
  const newFiles = currentInventory.filter((entry) => !previousInventory.has(entry.path));
  const changedScopeFiles = currentInventory.filter((entry) => {
    const previous = previousInventory.get(entry.path);
    return previous ? previous.fingerprint !== entry.fingerprint : false;
  });
  const missingScopeFiles = normalized.lastRun.fileInventory.filter(
    (entry) => !currentInventoryByPath.has(entry.path),
  );

  for (const checked of normalized.lastRun.checkedFiles) {
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
    normalized.tracked,
    scopeRoot,
    previousInventory,
    currentInventoryByPath,
  );

  const activeTracked = Object.fromEntries(
    Object.entries(normalized.tracked).filter(([subject]) => !staleTrackedSubjects.includes(subject)),
  );

  return {
    record: {
      ...normalized,
      tracked: activeTracked,
    },
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
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
  await mkdir(memoryDir, { recursive: true });
  const file = memoryFilePath(memoryDir, record.daemon);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

export async function createDaemonMemoryStore(
  daemonName: string,
  scopeRoot: string,
  explicitDir?: string,
): Promise<DaemonMemoryStore> {
  const memoryDir = await resolveMemoryDir(scopeRoot, explicitDir);
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
      await saveMemoryRecord(state, scopeRoot, explicitDir);
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
        await saveMemoryRecord(state, scopeRoot, explicitDir);
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
    if (current) {
      out.push({ path: relPath, ...current });
    }
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
    unchangedFiles,
    changedFiles,
    missingFiles,
    newFiles,
    changedScopeFiles,
    missingScopeFiles,
    staleTrackedSubjects,
  } = snapshot;
  const lines = [
    "Runner-managed memory from the last successful run is available.",
    "Use it to avoid rereading unchanged files unless another changed contract invalidates that conclusion.",
    "Start with tracked subjects and delta files before broad reads.",
    `Previous summary: ${record.lastRun.summary}`,
    `Previously checked files: ${record.lastRun.checkedFiles.length}`,
    `Unchanged since last run: ${unchangedFiles.length}`,
    `Changed since last run: ${changedFiles.length}`,
    `Missing since last run: ${missingFiles.length}`,
    `New since last run: ${newFiles.length}`,
    `Changed anywhere in scope since last run: ${changedScopeFiles.length}`,
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
    lines.push("New files since last run:");
    for (const file of newPreview) lines.push(`- ${file}`);
  }

  const changedScopePreview = changedScopeFiles
    .filter((f) => !changedPreview.includes(f.path))
    .slice(0, 12)
    .map((f) => f.path);
  if (changedScopePreview.length > 0) {
    lines.push("Changed files anywhere in scope since last run:");
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
    lines.push("Files removed from scope since last run:");
    for (const file of missingScopePreview) lines.push(`- ${file}`);
  }

  if (staleTrackedSubjects.length > 0) {
    lines.push("Tracked subjects invalidated since last run:");
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
  updatedAt?: string;
}): DaemonMemoryRecord {
  return {
    version: MEMORY_VERSION,
    daemon: input.daemon,
    scopeRoot: input.scopeRoot,
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

function normalizeMemoryRecord(
  raw: unknown,
  daemonName: string,
  scopeRoot: string,
): DaemonMemoryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<DaemonMemoryRecord> & {
    tracked?: Record<string, unknown>;
    lastRun?: Partial<DaemonMemoryRecord["lastRun"]>;
  };
  if (parsed.version !== MEMORY_VERSION && (parsed.version as number | undefined) !== 1) return null;

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
    daemon: parsed.daemon ?? daemonName,
    scopeRoot: parsed.scopeRoot ?? scopeRoot,
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
