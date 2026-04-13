import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunRecord, RunStore } from "../util/types";

function runPath(runsDir: string, runId: string) {
  return join(runsDir, `${runId}.json`);
}

export class FilesystemRunStore implements RunStore {
  constructor(private readonly runsDir: string) {}

  async ensureRun(
    runId: string,
    script: string,
    workspaceDir: string,
    dependencyHashes: Record<string, string>,
  ): Promise<RunRecord> {
    const existing = await this.getRun(runId);
    if (existing) {
      existing.script = script;
      existing.workspaceDir = workspaceDir;
      existing.dependencyHashes = dependencyHashes;
      return existing;
    }

    const now = new Date().toISOString();
    const created: RunRecord = {
      runId,
      script,
      dependencyHashes,
      createdAt: now,
      updatedAt: now,
      workspaceDir,
      journal: [],
      commandNodes: {},
    };
    await this.saveRun(created);
    return created;
  }

  async saveRun(record: RunRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    const path = runPath(this.runsDir, record.runId);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const path = runPath(this.runsDir, runId);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return null;
    }

    return (await file.json()) as RunRecord;
  }
}
