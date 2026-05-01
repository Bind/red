import {
  listDaemonRuns,
  loadDaemonRun,
  loadLatestMemoryRecord,
  type DaemonMemoryRecord,
  type DaemonRunIndexEntry,
  type DaemonRunRecord,
} from "@red/daemons";

export interface DaemonObservabilityQuery {
  getMemory(daemonName: string, repoId?: string): Promise<DaemonMemoryRecord | null>;
  listRuns(daemonName: string, repoId?: string): Promise<DaemonRunIndexEntry[]>;
  getRun(daemonName: string, runId: string, repoId?: string): Promise<DaemonRunRecord | null>;
}

function canonicalRepoId(repoId?: string): string | undefined {
  const requested = repoId?.trim();
  const configured = process.env.AI_DAEMONS_MEMORY_REPO?.trim();
  if (!requested) return configured;
  if (configured && requested.toLowerCase() === configured.toLowerCase()) {
    return configured;
  }
  return requested;
}

// scopeRoot is only used to locate the repoId, which is always overridden by
// AI_DAEMONS_MEMORY_REPO when set. Pass cwd so we never need the daemon spec
// files on disk — the name + env-supplied repoId are sufficient to key R2.
export function createDaemonObservabilityQuery(): DaemonObservabilityQuery {
  const scopeRoot = process.cwd();
  return {
    async getMemory(daemonName, repoId) {
      return loadLatestMemoryRecord(daemonName, scopeRoot, undefined, canonicalRepoId(repoId));
    },
    async listRuns(daemonName, repoId) {
      return listDaemonRuns(daemonName, scopeRoot, undefined, canonicalRepoId(repoId));
    },
    async getRun(daemonName, runId, repoId) {
      return loadDaemonRun(daemonName, scopeRoot, runId, undefined, canonicalRepoId(repoId));
    },
  };
}
