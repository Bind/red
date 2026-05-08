import type { ChangeQueries, EventQueries, JobQueries } from "../db/queries";
import type { ScoringEngine } from "../engine/review";
import type { ChangeStateMachine } from "../engine/state-machine";
import type { RepositoryProvider } from "../repo/repository-provider";
import type { Job, NotificationConfig } from "../types";
import type { NotificationSender } from "./notify";

export interface WorkerDeps {
  changes: ChangeQueries;
  events: EventQueries;
  jobs: JobQueries;
  repositoryProvider: RepositoryProvider;
  scorer: ScoringEngine;
  stateMachine: ChangeStateMachine;
  notifier: NotificationSender;
  notificationConfigs: NotificationConfig[];
}

export interface WorkerConfig {
  /** Poll interval in ms. Default: 1000 */
  pollInterval: number;
  /** Commit status context name. Default: "red" */
  statusContext: string;
  /** Git remote name to fetch after merging. Null to skip. */
  fetchRemoteAfterMerge: string | null;
}

const DEFAULT_CONFIG: WorkerConfig = {
  pollInterval: 1000,
  statusContext: "red",
  fetchRemoteAfterMerge: null,
};

/**
 * Job worker — polls the SQLite job queue and processes scoring jobs.
 *
 * Job types:
 *   - score_change: fetch diff → score → transition to ready_for_review
 *   - send_notification: deliver webhook/slack notifications
 */
export class JobWorker {
  private config: WorkerConfig;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: WorkerDeps,
    config: Partial<WorkerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Process a single job cycle. Exposed for testing. */
  async tick(): Promise<Job | null> {
    const job = this.deps.jobs.claimNext();
    if (!job) return null;

    try {
      switch (job.type) {
        case "score_change":
          await this.handleScoreChange(job);
          break;
        case "send_notification":
          await this.handleSendNotification(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      this.deps.jobs.complete(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.jobs.fail(job.id, message);
    }

    return job;
  }

  private poll(): void {
    if (!this.running) return;
    this.tick().finally(() => {
      if (this.running) {
        this.timer = setTimeout(() => this.poll(), this.config.pollInterval);
      }
    });
  }

  private async handleScoreChange(job: Job): Promise<void> {
    const { change_id } = JSON.parse(job.payload) as { change_id: number };
    const change = this.deps.changes.getById(change_id);
    if (!change) throw new Error(`Change ${change_id} not found`);
    if (change.status === "superseded") return;

    const [owner, repo] = parseRepoFullName(change.repo);

    this.deps.stateMachine.transition(change_id, "scoring");

    const diffStats = await this.deps.repositoryProvider.compareDiff(
      owner,
      repo,
      change.base_branch,
      change.head_sha,
    );

    const result = this.deps.scorer.score(diffStats);
    this.deps.changes.updateConfidence(change_id, result.confidence);
    this.deps.changes.updateDiffStats(change_id, JSON.stringify(diffStats));

    this.deps.stateMachine.transition(change_id, "scored", {
      confidence: result.confidence,
      reasons: result.reasons,
    });
    this.deps.stateMachine.transition(change_id, "ready_for_review");

    if (this.deps.notificationConfigs.length > 0) {
      const event = result.confidence === "critical" ? "change_critical" : "change_ready";
      this.deps.jobs.enqueue({
        org_id: change.org_id,
        type: "send_notification",
        payload: JSON.stringify({ change_id, event }),
      });
    }
  }

  private async handleSendNotification(job: Job): Promise<void> {
    const { change_id, event } = JSON.parse(job.payload) as {
      change_id: number;
      event: "change_ready" | "change_critical";
    };

    const change = this.deps.changes.getById(change_id);
    if (!change) throw new Error(`Change ${change_id} not found`);

    const results = await this.deps.notifier.send(this.deps.notificationConfigs, change, event);

    // Log notification results
    this.deps.events.append({
      change_id,
      event_type: "notification_sent",
      metadata: JSON.stringify({
        event,
        results: results.map((r) => ({
          url: r.url,
          success: r.success,
          error: r.error,
        })),
      }),
    });
  }
}

function parseRepoFullName(fullName: string): [string, string] {
  const [owner, ...rest] = fullName.split("/");
  return [owner, rest.join("/")];
}
