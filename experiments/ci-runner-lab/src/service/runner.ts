import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RunnerConfig,
  RunnerService,
  RunRequest,
  RunStepInput,
  RunStore,
  StepResult,
  WorkflowRun,
} from "../util/types";

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeStepResult(step: RunStepInput): StepResult {
  return {
    name: step.name,
    command: step.run,
    status: "queued",
    stdout: "",
    stderr: "",
  };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

export class LocalRunnerService implements RunnerService {
  private readonly queue: string[] = [];
  private runningCount = 0;

  constructor(
    private readonly config: RunnerConfig,
    private readonly store: RunStore,
  ) {}

  queueRun(request: RunRequest): WorkflowRun {
    const run: WorkflowRun = {
      id: createRunId(),
      workflowName: request.workflowName,
      repository: request.repository,
      ref: request.ref,
      sha: request.sha,
      env: request.env ?? {},
      status: "queued",
      createdAt: nowIso(),
      stepResults: request.steps.map((step) => makeStepResult(step)),
    };

    this.store.createRun(run);
    this.queue.push(run.id);
    queueMicrotask(() => {
      void this.drainQueue();
    });
    return run;
  }

  listRuns(): WorkflowRun[] {
    return this.store.listRuns();
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.store.getRun(id);
  }

  getState() {
    return {
      runningCount: this.runningCount,
      queuedCount: this.queue.length,
      maxConcurrentRuns: this.config.maxConcurrentRuns,
    };
  }

  private async drainQueue() {
    while (this.runningCount < this.config.maxConcurrentRuns) {
      const nextRunId = this.queue.shift();
      if (!nextRunId) {
        return;
      }

      this.runningCount += 1;
      void this.executeRun(nextRunId).finally(() => {
        this.runningCount -= 1;
        void this.drainQueue();
      });
    }
  }

  private async executeRun(runId: string) {
    const initial = this.store.getRun(runId);
    if (!initial) {
      return;
    }

    const runDir = join(this.config.workDir, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runDir, "run.json"),
      `${JSON.stringify(
        {
          id: initial.id,
          workflowName: initial.workflowName,
          repository: initial.repository,
          ref: initial.ref,
          sha: initial.sha ?? null,
          env: initial.env,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    this.store.updateRun(runId, (run) => ({
      ...run,
      status: "running",
      startedAt: nowIso(),
      stepResults: run.stepResults.map((step) => ({ ...step, status: "queued" })),
    }));

    let failed = false;

    for (let index = 0; index < initial.stepResults.length; index += 1) {
      const step = initial.stepResults[index];
      if (!step) {
        failed = true;
        break;
      }
      const startedAt = nowIso();

      this.store.updateRun(runId, (run) => ({
        ...run,
        stepResults: run.stepResults.map((entry, currentIndex) =>
          currentIndex === index ? { ...entry, status: "running", startedAt } : entry,
        ),
      }));

      try {
        const proc = Bun.spawn({
          cmd: ["sh", "-lc", step.command],
          cwd: runDir,
          env: {
            ...process.env,
            ...initial.env,
            CI_RUNNER_RUN_ID: initial.id,
            CI_RUNNER_WORKFLOW: initial.workflowName,
            CI_RUNNER_REPOSITORY: initial.repository,
            CI_RUNNER_REF: initial.ref,
            CI_RUNNER_SHA: initial.sha ?? "",
            CI_RUNNER_WORKSPACE: runDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        const killTimer = setTimeout(() => {
          proc.kill();
        }, this.config.stepTimeoutMs);

        const [stdout, stderr, exitCode] = await Promise.all([
          readText(proc.stdout),
          readText(proc.stderr),
          proc.exited,
        ]);

        clearTimeout(killTimer);

        const success = exitCode === 0;
        this.store.updateRun(runId, (run) => ({
          ...run,
          stepResults: run.stepResults.map((entry, currentIndex) =>
            currentIndex === index
              ? {
                  ...entry,
                  status: success ? "success" : "failed",
                  finishedAt: nowIso(),
                  exitCode,
                  stdout,
                  stderr,
                }
              : entry,
          ),
        }));

        if (!success) {
          failed = true;
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        this.store.updateRun(runId, (run) => ({
          ...run,
          stepResults: run.stepResults.map((entry, currentIndex) =>
            currentIndex === index
              ? {
                  ...entry,
                  status: "failed",
                  finishedAt: nowIso(),
                  exitCode: 1,
                  stderr: message,
                }
              : entry,
          ),
        }));
        failed = true;
        break;
      }
    }

    this.store.updateRun(runId, (run) => ({
      ...run,
      status: failed ? "failed" : "success",
      finishedAt: nowIso(),
    }));
  }
}
