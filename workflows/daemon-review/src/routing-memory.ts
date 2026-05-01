import { join, posix } from "node:path";
import type { DaemonMemorySnapshot } from "../../../pkg/daemons/src/index";

export type DaemonRoutingMemory = {
  checkedFiles: string[];
  dependencyFiles: string[];
  trackedSubjects: string[];
  staleTrackedSubjects: string[];
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeScopePrefix(scopePrefix: string): string {
  return scopePrefix.replace(/^\/+|\/+$/g, "");
}

function toRepoRelativePath(scopePrefix: string, relativePath: string): string {
  const normalizedPrefix = normalizeScopePrefix(scopePrefix);
  const normalizedPath = relativePath.replace(/^\/+/, "");
  if (!normalizedPrefix) return normalizedPath;
  return posix.normalize(join(normalizedPrefix, normalizedPath).replace(/\\/g, "/"));
}

export function buildDaemonRoutingMemory(
  snapshot: DaemonMemorySnapshot | null,
  scopePrefix: string,
): DaemonRoutingMemory {
  if (!snapshot) {
    return {
      checkedFiles: [],
      dependencyFiles: [],
      trackedSubjects: [],
      staleTrackedSubjects: [],
    };
  }

  const checkedFiles = snapshot.record.lastRun.checkedFiles.map((entry) =>
    toRepoRelativePath(scopePrefix, entry.path),
  );
  const dependencyFiles = Object.values(snapshot.record.tracked).flatMap((entry) =>
    entry.depends_on.map((path) => toRepoRelativePath(scopePrefix, path)),
  );

  return {
    checkedFiles: uniqueSorted(checkedFiles),
    dependencyFiles: uniqueSorted(dependencyFiles),
    trackedSubjects: uniqueSorted(Object.keys(snapshot.record.tracked)),
    staleTrackedSubjects: uniqueSorted(snapshot.staleTrackedSubjects),
  };
}
