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
  /** Git remote name to fetch after merging. Null to skip. */
  fetchRemoteAfterMerge: string | null;
}

const DEFAULT_CONFIG: WorkerConfig = {
  pollInterval: 1000,
  statusContext: "redc",
  fetchRemoteAfterMerge: null,
};

/**
 * Job worker — polls the SQLite job queue and processes scoring/summary jobs.
 *
 * Job types:
 *   - score_change: fetch diff → score → set commit status → enqueue summary
 *   - generate_summary: generate LLM summary → transition to ready_for_review
 *   - send_notification: deliver webhook/slack notifications
 *   - approve_change: auto-approve and enqueue merge
 *   - merge_change: create PR if needed, merge, transition to merged
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
        case "approve_change":
          await this.handleApproveChange(job);
          break;
        case "merge_change":
          await this.handleMergeChange(job);
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

    // Auto-approve if policy says so
    if (payload.policy_decision?.action === "auto-approve") {
      this.deps.jobs.enqueue({
        org_id: change.org_id,
        type: "approve_change",
        payload: JSON.stringify({
          change_id: change.id,
          policy_decision: payload.policy_decision,
        }),
      });
    }
  }

  private async handleApproveChange(job: Job): Promise<void> {
    const { change_id, policy_decision } = JSON.parse(job.payload) as {
      change_id: number;
      policy_decision: { action: string };
    };

    const change = this.deps.changes.getById(change_id);
    if (!change) throw new Error(`Change ${change_id} not found`);
    if (change.status === "superseded") return;

    // Only auto-approve; anything else stays at ready_for_review for manual review
    if (policy_decision.action !== "auto-approve") {
      this.deps.events.append({
        change_id,
        event_type: "approval_skipped",
        metadata: JSON.stringify({ reason: "not auto-approve", action: policy_decision.action }),
      });
      return;
    }

    const [owner, repo] = parseRepoFullName(change.repo);

    // Transition → approved
    this.deps.stateMachine.transition(change_id, "approved");

    // Set commit status to success
    await this.deps.forgejo.setCommitStatus(owner, repo, change.head_sha, {
      state: "success",
      description: "Approved by redc",
      context: this.config.statusContext,
    });

    // Log approval event
    this.deps.events.append({
      change_id,
      event_type: "change_approved",
      from_status: "ready_for_review",
      to_status: "approved",
      metadata: JSON.stringify({ policy_decision }),
    });

    // Enqueue merge
    this.deps.jobs.enqueue({
      org_id: change.org_id,
      type: "merge_change",
      payload: JSON.stringify({ change_id }),
    });
  }

  private async handleMergeChange(job: Job): Promise<void> {
    const { change_id } = JSON.parse(job.payload) as { change_id: number };

    const change = this.deps.changes.getById(change_id);
    if (!change) throw new Error(`Change ${change_id} not found`);
    if (change.status === "superseded") return;

    const [owner, repo] = parseRepoFullName(change.repo);

    // Find or create PR
    let prNumber = change.pr_number;

    if (!prNumber) {
      // Try to find an existing open PR for this branch
      const prs = await this.deps.forgejo.listPRsForBranch(owner, repo, change.branch);
      if (prs.length > 0) {
        prNumber = prs[0].number;
        this.deps.changes.updatePrNumber(change_id, prNumber);
      }
    }

    if (!prNumber) {
      // Create a new PR
      const summary = change.summary ? JSON.parse(change.summary) : null;
      const title = summary?.title || `Merge ${change.branch}`;
      const pr = await this.deps.forgejo.createPR(owner, repo, {
        title,
        head: change.branch,
        base: change.base_branch,
        body: summary?.description || undefined,
      });
      prNumber = pr.number;
      this.deps.changes.updatePrNumber(change_id, prNumber);
    }

    // Transition → merging
    this.deps.stateMachine.transition(change_id, "merging");

    // Merge the PR
    try {
      await this.deps.forgejo.mergePR(owner, repo, prNumber, "merge");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.stateMachine.transition(change_id, "merge_failed");
      this.deps.events.append({
        change_id,
        event_type: "merge_failed",
        from_status: "merging",
        to_status: "merge_failed",
        metadata: JSON.stringify({ error: message, pr_number: prNumber }),
      });
      return; // Don't rethrow — the state machine captures the failure
    }

    // Transition → merged
    this.deps.stateMachine.transition(change_id, "merged");

    // Fetch the updated remote so local refs stay in sync
    if (this.config.fetchRemoteAfterMerge) {
      try {
        const proc = Bun.spawn(["git", "fetch", this.config.fetchRemoteAfterMerge]);
        await proc.exited;
      } catch {
        // Non-fatal — local ref sync is best-effort
      }
    }

    // Log merge event
    this.deps.events.append({
      change_id,
      event_type: "change_merged",
      from_status: "merging",
      to_status: "merged",
      metadata: JSON.stringify({ pr_number: prNumber }),
    });

    // Enqueue notification if configs exist
    if (this.deps.notificationConfigs.length > 0) {
      this.deps.jobs.enqueue({
        org_id: change.org_id,
        type: "send_notification",
        payload: JSON.stringify({ change_id, event: "change_merged" }),
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
