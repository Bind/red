import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { CompleteFinding } from "./schema";

export const DEFAULT_MEMORY_DIRNAME = ".daemons-cache";
const MEMORY_VERSION = 1;
const REPO_MARKERS = ["turbo.json", "package.json", ".git"];

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
  lastRun: {
    summary: string;
    nextRunHint?: string;
    findings: CompleteFinding[];
    checkedFiles: CheckedFileRecord[];
  };
};

export type DaemonMemorySnapshot = {
  record: DaemonMemoryRecord;
  unchangedFiles: CheckedFileRecord[];
  changedFiles: CheckedFileRecord[];
  missingFiles: CheckedFileRecord[];
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
  if (parsed.version !== MEMORY_VERSION) return null;

  const unchangedFiles: CheckedFileRecord[] = [];
  const changedFiles: CheckedFileRecord[] = [];
  const missingFiles: CheckedFileRecord[] = [];

  for (const checked of parsed.lastRun.checkedFiles) {
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

  return { record: parsed, unchangedFiles, changedFiles, missingFiles };
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

export function buildMemoryPrompt(snapshot: DaemonMemorySnapshot | null): string | null {
  if (!snapshot) return null;
  const { record, unchangedFiles, changedFiles, missingFiles } = snapshot;
  const lines = [
    "Runner-managed memory from the last successful run is available.",
    "Use it to avoid rereading unchanged files unless another changed contract invalidates that conclusion.",
    `Previous summary: ${record.lastRun.summary}`,
    `Previously checked files: ${record.lastRun.checkedFiles.length}`,
    `Unchanged since last run: ${unchangedFiles.length}`,
    `Changed since last run: ${changedFiles.length}`,
    `Missing since last run: ${missingFiles.length}`,
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

  if (record.lastRun.nextRunHint) {
    lines.push(`Previous nextRunHint: ${record.lastRun.nextRunHint}`);
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
  const absolute = resolve(scopeRoot, rawPath);
  const rel = relative(scopeRoot, absolute);
  if (rel === "" || rel.startsWith("..")) return null;
  return rel;
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
