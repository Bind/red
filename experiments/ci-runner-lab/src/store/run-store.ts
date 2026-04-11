import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunStore, WorkflowRun } from "../util/types";

interface RunStoreData {
  runs: WorkflowRun[];
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(run)) as WorkflowRun;
}

export class FileRunStore implements RunStore {
  private data: RunStoreData;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.load();
    this.flush();
  }

  listRuns(): WorkflowRun[] {
    return this.data.runs.map((run) => cloneRun(run));
  }

  getRun(id: string): WorkflowRun | undefined {
    const run = this.data.runs.find((entry) => entry.id === id);
    return run ? cloneRun(run) : undefined;
  }

  createRun(run: WorkflowRun): WorkflowRun {
    this.data.runs.unshift(cloneRun(run));
    this.flush();
    return cloneRun(run);
  }

  updateRun(id: string, updater: (run: WorkflowRun) => WorkflowRun): WorkflowRun {
    const index = this.data.runs.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`run ${id} not found`);
    }

    const current = this.data.runs[index];
    if (!current) {
      throw new Error(`run ${id} not found`);
    }

    const updated = updater(cloneRun(current));
    this.data.runs[index] = cloneRun(updated);
    this.flush();
    return cloneRun(updated);
  }

  private load(): RunStoreData {
    if (!existsSync(this.filePath)) {
      return { runs: [] };
    }

    const raw = readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return { runs: [] };
    }

    const parsed = JSON.parse(raw) as Partial<RunStoreData>;
    return {
      runs: Array.isArray(parsed.runs) ? parsed.runs.map((run) => cloneRun(run)) : [],
    };
  }

  private flush() {
    writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}
