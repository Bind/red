import type { ChangeQueries, JobQueries, SessionQueries } from "../db/queries";
import type { ChangeStateMachine } from "../engine/state-machine";
import type { ClawRunRecord, ClawRunTracker } from "./types";

export interface ClawRunReconcilerDeps {
  tracker: ClawRunTracker;
  changes: ChangeQueries;
  jobs: JobQueries;
  sessions: SessionQueries;
  stateMachine: ChangeStateMachine;
}

export interface ClawRunReconcilerConfig {
  intervalMs: number;
}

const DEFAULT_CONFIG: ClawRunReconcilerConfig = {
  intervalMs: 30_000,
};

export class ClawRunReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private config: ClawRunReconcilerConfig;

  constructor(
    private deps: ClawRunReconcilerDeps,
    config: Partial<ClawRunReconcilerConfig> = {}
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

  async reconcileOnce(): Promise<void> {
    const runningRuns = this.deps.tracker.listByStatus("running", 100);
    for (const run of runningRuns) {
      const state = await inspectContainerState(run.containerId ?? run.containerName);
      if (state?.running) continue;
      this.reconcileMissingContainer(run, state);
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.reconcileOnce()
      .catch(() => {})
      .finally(() => {
        if (!this.running) return;
        this.timer = setTimeout(() => this.schedule(), this.config.intervalMs);
      });
  }

  private reconcileMissingContainer(run: ClawRunRecord, state: ContainerState | null): void {
    const finishedAt = new Date().toISOString();
    const durationMs = run.startedAt
      ? Math.max(0, Date.now() - new Date(run.startedAt).getTime())
      : 0;
    const errorMessage = formatReconciledError(state);

    this.deps.tracker.finish(run.runId, {
      status: "failed",
      finishedAt,
      durationMs,
      errorType: "runtime_error",
      errorMessage,
    });

    const change = run.changeId != null
      ? this.deps.changes.getById(run.changeId)
      : this.deps.changes.getLatestByRepoHead(run.repo, run.headRef);
    if (!change) return;

    const jobType = mapRunJobNameToSessionJobType(run.jobName);
    const session = jobType
      ? this.deps.sessions.findLatestRunningByChangeAndJobType(change.id, jobType)
      : null;

    if (session) {
      this.deps.sessions.finish(session.id, "failed", durationMs);
      if (session.job_id != null) {
        const job = this.deps.jobs.getById(session.job_id);
        if (job?.status === "processing") {
          this.deps.jobs.fail(session.job_id, errorMessage);
        }
      }
    }

    if (change.status === "summarizing") {
      try {
        this.deps.stateMachine.transition(change.id, "scored", {
          reason: "claw_run_reconciled_failed",
          run_id: run.runId,
        });
      } catch {
        // Best-effort reconciliation; status may have changed concurrently.
      }
    }
  }
}

function mapRunJobNameToSessionJobType(jobName: string): string | null {
  switch (jobName) {
    case "generate-summary":
      return "generate_summary";
    default:
      return null;
  }
}

type ContainerState = {
  running: boolean;
  status?: string;
  exitCode?: number;
  error?: string;
  oomKilled?: boolean;
  finishedAt?: string;
};

async function inspectContainerState(containerRef: string): Promise<ContainerState | null> {
  if (!containerRef) return null;
  const proc = Bun.spawn(
    ["docker", "inspect", "-f", "{{json .State}}", containerRef],
    {
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !stdout.trim()) return null;

  try {
    const state = JSON.parse(stdout) as {
      Running?: boolean;
      Status?: string;
      ExitCode?: number;
      Error?: string;
      OOMKilled?: boolean;
      FinishedAt?: string;
    };
    return {
      running: state.Running === true,
      status: state.Status,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : undefined,
      error: typeof state.Error === "string" ? state.Error : undefined,
      oomKilled: state.OOMKilled === true,
      finishedAt: typeof state.FinishedAt === "string" ? state.FinishedAt : undefined,
    };
  } catch {
    return null;
  }
}

function formatReconciledError(state: ContainerState | null): string {
  if (!state) {
    return "Runner container disappeared before the job completed";
  }

  const details: string[] = [];
  if (state.status) details.push(`status=${state.status}`);
  if (state.exitCode != null) details.push(`exit_code=${state.exitCode}`);
  if (state.oomKilled) details.push("oom_killed=true");
  if (state.finishedAt && state.finishedAt !== "0001-01-01T00:00:00Z") {
    details.push(`finished_at=${state.finishedAt}`);
  }
  if (state.error) details.push(`error=${state.error}`);

  if (details.length === 0) {
    return "Runner container exited before the job completed";
  }

  return `Runner container exited before the job completed (${details.join(", ")})`;
}
