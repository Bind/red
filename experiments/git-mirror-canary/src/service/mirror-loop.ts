import { randomUUID } from "node:crypto";
import type {
  CanaryConfig,
  CanaryEvent,
  Clock,
  MirrorEventPublisher,
  MirrorGitClient,
  MirrorRepoConfig,
  MirrorStateStore,
  RepoStatusRecord,
} from "../util/types";

const systemClock: Clock = {
  now: () => new Date(),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MirrorLoopService {
  private timer: Timer | null = null;
  private running = false;

  constructor(
    private readonly config: CanaryConfig,
    private readonly store: MirrorStateStore,
    private readonly git: MirrorGitClient,
    private readonly publisher: MirrorEventPublisher,
    private readonly clock: Clock = systemClock,
  ) {}

  start() {
    const minInterval = Math.min(
      ...this.config.repos.map((repo) => repo.pollIntervalMs ?? this.config.pollIntervalMs),
    );
    this.timer = setInterval(() => {
      void this.runOnce();
    }, minInterval);
    void this.runOnce();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(repoIds?: string[]) {
    if (this.running) return;
    this.running = true;
    try {
      const force = Boolean(repoIds?.length);
      const repos = repoIds?.length
        ? this.config.repos.filter((repo) => repoIds.includes(repo.id))
        : this.config.repos.filter((repo) => force || this.shouldRunRepo(repo));

      for (const repo of repos) {
        await this.runRepo(repo);
      }
    } finally {
      this.running = false;
    }
  }

  private shouldRunRepo(repo: MirrorRepoConfig) {
    const previous = this.store.getRepoStatus(repo.id);
    if (!previous?.lastRunAt) {
      return true;
    }

    const lastRunAt = new Date(previous.lastRunAt).getTime();
    if (Number.isNaN(lastRunAt)) {
      return true;
    }

    const intervalMs = repo.pollIntervalMs ?? this.config.pollIntervalMs;
    return this.clock.now().getTime() - lastRunAt >= intervalMs;
  }

  private async runRepo(repo: MirrorRepoConfig) {
    const previous = this.store.getRepoStatus(repo.id);
    const now = this.clock.now().toISOString();

    try {
      const cachePath = await this.git.ensureLocalMirror(repo, this.config.cacheDir);
      const sourceHead = await this.git.resolveLocalRef(cachePath, repo.trackedRef);
      await this.git.pushMirror(cachePath, repo);
      const targetHead = await this.git.resolveRemoteRef(repo);

      if (sourceHead !== targetHead) {
        throw new Error(
          `target ref ${repo.trackedRef} did not converge: source=${sourceHead} target=${targetHead}`,
        );
      }

      const nextStatus: RepoStatusRecord = {
        repoId: repo.id,
        trackedRef: repo.trackedRef,
        lastRunStatus: "success",
        lastSourceHead: sourceHead,
        lastTargetHead: targetHead,
        lastRunAt: now,
        lastSuccessAt: now,
        lastError: undefined,
        consecutiveFailures: 0,
      };
      this.store.upsertRepoStatus(nextStatus);

      if (previous?.lastSourceHead && previous.lastSourceHead !== sourceHead) {
        await this.emit({
          repoId: repo.id,
          type: "source_advanced",
          severity: "info",
          occurredAt: now,
          message: `source advanced on ${repo.trackedRef}`,
          details: {
            previousSourceHead: previous.lastSourceHead,
            sourceHead,
            trackedRef: repo.trackedRef,
          },
        });
      }

      await this.emit({
        repoId: repo.id,
        type: "mirror_succeeded",
        severity: "info",
        occurredAt: now,
        message: `mirror succeeded for ${repo.id}`,
        details: {
          trackedRef: repo.trackedRef,
          sourceHead,
          targetHead,
        },
      });
    } catch (error) {
      const nextStatus: RepoStatusRecord = {
        repoId: repo.id,
        trackedRef: repo.trackedRef,
        lastRunStatus: "error",
        lastSourceHead: previous?.lastSourceHead,
        lastTargetHead: previous?.lastTargetHead,
        lastRunAt: now,
        lastSuccessAt: previous?.lastSuccessAt,
        lastError: errorMessage(error),
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      };
      this.store.upsertRepoStatus(nextStatus);

      await this.emit({
        repoId: repo.id,
        type: "mirror_issue",
        severity: "error",
        occurredAt: now,
        message: `mirror failed for ${repo.id}`,
        details: {
          trackedRef: repo.trackedRef,
          error: errorMessage(error),
          consecutiveFailures: nextStatus.consecutiveFailures,
        },
      });
    }
  }

  private async emit(event: Omit<CanaryEvent, "id">) {
    const withId: CanaryEvent = {
      id: randomUUID(),
      ...event,
    };
    this.store.appendEvent(withId);
    await this.publisher.publish(withId);
  }
}
