import type { ChangeQueries, EventQueries, JobQueries, SessionQueries } from "../db/queries";
import type { SummaryGenerator, SummaryInput } from "../engine/summary";
import type { DiffStats, Job, NotificationConfig } from "../types";
import type { AgentRuntimeEvent } from "../claw/runtime";
import type { EventBus } from "../engine/event-bus";
import type { RepositoryProvider } from "../repo/repository-provider";
import { ScoringEngine } from "../engine/review";
import { PolicyEngine } from "../engine/policy";
import { ChangeStateMachine } from "../engine/state-machine";
import { NotificationSender } from "./notify";

export interface WorkerDeps {
  changes: ChangeQueries;
  events: EventQueries;
  jobs: JobQueries;
  repositoryProvider: RepositoryProvider;
  scorer: ScoringEngine;
  policy: PolicyEngine;
  summary: SummaryGenerator;
  stateMachine: ChangeStateMachine;
  notifier: NotificationSender;
  notificationConfigs: NotificationConfig[];
  eventBus?: EventBus;
  sessions?: SessionQueries;
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
 *   - score_change: fetch diff → score → enqueue summary
 *   - generate_summary: generate LLM summary → transition to ready_for_review
 *   - send_notification: deliver webhook/slack notifications
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

    // Fetch diff stats
    const diffStats = await this.deps.repositoryProvider.compareDiff(
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
    const diff = await this.deps.repositoryProvider.getDiff(
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
      baseRef: change.base_branch,
      headRef: change.head_sha,
      changeId: change.id,
      jobId: job.id,
      diff,
      diffStats: payload.diff_stats,
      confidence: change.confidence!,
      commitMessages,
    };

    // Create a persistent session if sessions are available
    const runId = crypto.randomUUID();
    const session = this.deps.sessions?.create({
      changeId: change.id,
      jobId: job.id,
      jobType: job.type,
      runId,
      runtime: "opencode",
    });
    const startTime = Date.now();

    const onEvent = (event: AgentRuntimeEvent) => {
      if (session) {
        const persistedEvent = this.deps.sessions!.appendEvent(session.id, event);
        if (event.runtimeSessionId && !session.runtime_session_id) {
          this.deps.sessions!.attachRuntimeSessionId(session.id, event.runtimeSessionId);
          session.runtime_session_id = event.runtimeSessionId;
        }
        this.deps.eventBus?.emit(change.id, persistedEvent);
        return;
      }
    };

    let summary;
    try {
      summary = await this.deps.summary.generate({
        ...input,
        jobId: job.id,
      }, onEvent);
      if (session) {
        this.deps.sessions!.finish(session.id, "completed", Date.now() - startTime);
      }
    } catch (err) {
      if (session) {
        this.deps.sessions!.finish(session.id, "failed", Date.now() - startTime);
      }
      if (change.status === "summarizing") {
        this.deps.stateMachine.transition(change.id, "scored", {
          reason: "summary_generation_failed",
        });
      }
      throw err;
    } finally {
      this.deps.eventBus?.complete(change.id);
    }

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
      metadata: JSON.stringify({
        recommended_action: summary.recommended_action,
        generator: this.deps.summary.getMetadata(),
      }),
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
      event: "change_ready" | "change_critical";
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
