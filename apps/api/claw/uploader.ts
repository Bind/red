import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ClawRunTracker } from "./types";
import { getLocalArtifactRunDir, type MinioClawArtifactStore } from "./artifacts";

export interface ClawArtifactUploaderDeps {
  tracker: ClawRunTracker;
  remoteStore: MinioClawArtifactStore;
}

export interface ClawArtifactUploaderConfig {
  intervalMs: number;
  batchSize: number;
}

const DEFAULT_CONFIG: ClawArtifactUploaderConfig = {
  intervalMs: 15_000,
  batchSize: 100,
};

export class ClawArtifactUploader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly config: ClawArtifactUploaderConfig;

  constructor(
    private readonly deps: ClawArtifactUploaderDeps,
    config: Partial<ClawArtifactUploaderConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async uploadOnce(): Promise<void> {
    const candidates = [
      ...this.deps.tracker.listByStatus("completed", this.config.batchSize),
      ...this.deps.tracker.listByStatus("failed", this.config.batchSize),
    ];

    for (const run of candidates) {
      if (run.rolloutPath?.startsWith("s3://")) continue;

      const runDir = getLocalArtifactRunDir(run.runId);
      const inputDir = join(runDir, "input");
      const outputDir = join(runDir, "output");
      if (!(await pathExists(inputDir)) || !(await pathExists(outputDir))) continue;

      try {
        const persisted = await this.deps.remoteStore.persistRunArtifacts(run.runId, inputDir, outputDir);
        this.deps.tracker.attachRollout(run.runId, run.codexSessionId, persisted.rolloutPath);
      } catch {
        // Keep local artifacts and retry on the next pass.
      }
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.uploadOnce()
      .catch(() => {})
      .finally(() => {
        if (!this.running) return;
        this.timer = setTimeout(() => this.schedule(), this.config.intervalMs);
      });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
