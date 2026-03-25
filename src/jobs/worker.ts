import type { ChangeQueries, EventQueries, JobQueries } from "../db/queries";
import type { ForgejoClient } from "../forgejo/client";
import type { SummaryGenerator, SummaryInput } from "../engine/summary";
import type { Change, DiffStats, Job, NotificationConfig } from "../types";
import { ScoringEngine } from "../engine/review";
import { PolicyEngine } from "../engine/policy";
import { ChangeStateMachine } from "../engine/state-machine";
import { NotificationSender } from "./notify";

export interface WorkerDeps {
  changes: ChangeQueries;
  events: EventQueries;
  jobs: JobQueries;
  forgejo: ForgejoClient;
  scorer: ScoringEngine;
  policy: PolicyEngine;
  summary: SummaryGenerator;
  stateMachine: ChangeStateMachine;
  notifier: NotificationSender;
  notificationConfigs: NotificationConfig[];
}

export interface WorkerConfig {
  /** Poll interval in ms. Default: 1000 */
  pollInterval: number;
  /** Commit status context name. Default: "redc" */
  statusContext: string;
}

const DEFAULT_CONFIG: WorkerConfig = {
  pollInterval: 1000,
  statusContext: "redc",
};

/**
 * Job worker — polls the SQLite job queue and processes scoring/summary jobs.
 *
 * Job types:
 *   - score_change: fetch diff → score → set commit status → enqueue summary
 *   - generate_summary: generate LLM summary → transition to ready_for_review
 */
export class JobWorker {
  private config: WorkerConfig;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: WorkerDeps,
    config: Partial<WorkerConfig> = {}
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
        case "generate_summary":
          await this.handleGenerateSummary(job);
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
    if (change.status === "superseded") return; // skip superseded

    // Parse repo owner/name
    const [owner, repo] = parseRepoFullName(change.repo);

    // Transition to scoring
    this.deps.stateMachine.transition(change_id, "scoring");

    // Set commit status to pending
    await this.deps.forgejo.setCommitStatus(owner, repo, change.head_sha, {
      state: "pending",
      description: "Scoring change...",
      context: this.config.statusContext,
    });

    // Fetch diff stats
    const diffStats = await this.deps.forgejo.compareDiff(
      owner, repo, change.base_branch, change.head_sha
    );

    // Score
    const result = this.deps.scorer.score(diffStats);
    this.deps.changes.updateConfidence(change_id, result.confidence);
    this.deps.changes.updateDiffStats(change_id, JSON.stringify(diffStats));

    // Transition to scored via state machine
    this.deps.stateMachine.transition(change_id, "scored", {
      confidence: result.confidence,
      reasons: result.reasons,
    });

    // Evaluate policy
    const policy = await this.deps.policy.loadPolicy(owner, repo, change.base_branch);
    const decision = this.deps.policy.evaluate(policy, diffStats, result.confidence);

    // Set commit status based on scoring
    const statusState = result.confidence === "safe" ? "success" as const
      : result.confidence === "critical" ? "failure" as const
      : "pending" as const;

    await this.deps.forgejo.setCommitStatus(owner, repo, change.head_sha, {
      state: statusState,
      description: `${result.confidence}: ${result.reasons[0]}`,
      context: this.config.statusContext,
    });

    // Transition to summarizing and enqueue summary job
    this.deps.stateMachine.transition(change_id, "summarizing");
    this.deps.jobs.enqueue({
      org_id: change.org_id,
      type: "generate_summary",
      payload: JSON.stringify({
        change_id,
        diff_stats: diffStats,
        policy_decision: decision,
      }),
    });
  }

  private async handleGenerateSummary(job: Job): Promise<void> {
    const payload = JSON.parse(job.payload) as {
      change_id: number;
      diff_stats: DiffStats;
      policy_decision: { action: string };
    };

    const change = this.deps.changes.getById(payload.change_id);
    if (!change) throw new Error(`Change ${payload.change_id} not found`);
    if (change.status === "superseded") return;

    const [owner, repo] = parseRepoFullName(change.repo);

    // Fetch the actual diff text for the summary generator
    const diff = await this.deps.forgejo.getDiff(
      owner, repo, change.base_branch, change.head_sha
    );

    // Get commit messages from change events or use a placeholder
    const events = this.deps.events.listByChangeId(change.id);
    const pushEvent = events.find((e) => e.event_type === "push_received");
    const commitMessages = pushEvent?.metadata
      ? [JSON.parse(pushEvent.metadata).commits + " commit(s)"]
      : [];

    const input: SummaryInput = {
      repo: change.repo,
      branch: change.branch,
      diff,
      diffStats: payload.diff_stats,
      confidence: change.confidence!,
      commitMessages,
    };

    const summary = await this.deps.summary.generate(input);

    // Store summary
    this.deps.changes.updateSummary(change.id, JSON.stringify(summary));

    // Transition to ready_for_review
    this.deps.stateMachine.transition(change.id, "ready_for_review");

    // Log summary event
    this.deps.events.append({
      change_id: change.id,
      event_type: "summary_generated",
      from_status: "summarizing",
      to_status: "ready_for_review",
      metadata: JSON.stringify({ recommended_action: summary.recommended_action }),
    });

    // Enqueue notification if configs exist
    if (this.deps.notificationConfigs.length > 0) {
      const event = change.confidence === "critical" ? "change_critical" : "change_ready";
      this.deps.jobs.enqueue({
        org_id: change.org_id,
        type: "send_notification",
        payload: JSON.stringify({ change_id: change.id, event }),
      });
    }
  }

  private async handleSendNotification(job: Job): Promise<void> {
    const { change_id, event } = JSON.parse(job.payload) as {
      change_id: number;
      event: "change_ready" | "change_critical" | "change_merged";
    };

    const change = this.deps.changes.getById(change_id);
    if (!change) throw new Error(`Change ${change_id} not found`);

    const results = await this.deps.notifier.send(
      this.deps.notificationConfigs,
      change,
      event
    );

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
