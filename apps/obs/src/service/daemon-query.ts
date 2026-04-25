import {
  listDaemonRuns,
  loadDaemonRun,
  loadLatestMemoryRecord,
  resolveDaemon,
  type DaemonMemoryRecord,
  type DaemonRunIndexEntry,
  type DaemonRunRecord,
} from "@red/daemons";

export interface DaemonObservabilityQuery {
  getMemory(daemonName: string): Promise<DaemonMemoryRecord | null>;
  listRuns(daemonName: string): Promise<DaemonRunIndexEntry[]>;
  getRun(daemonName: string, runId: string): Promise<DaemonRunRecord | null>;
}

export function createDaemonObservabilityQuery(root = process.env.REPO_ROOT ?? process.cwd()): DaemonObservabilityQuery {
  return {
    async getMemory(daemonName) {
      const spec = await resolveDaemon(daemonName, root);
      return loadLatestMemoryRecord(spec.name, spec.scopeRoot);
    },
    async listRuns(daemonName) {
      const spec = await resolveDaemon(daemonName, root);
      return listDaemonRuns(spec.name, spec.scopeRoot);
    },
    async getRun(daemonName, runId) {
      const spec = await resolveDaemon(daemonName, root);
      return loadDaemonRun(spec.name, spec.scopeRoot, runId);
    },
  };
}
