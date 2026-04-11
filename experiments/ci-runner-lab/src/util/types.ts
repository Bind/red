export type RunnerMode = "dev" | "compose";
export type RunStatus = "queued" | "running" | "success" | "failed";
export type StepStatus = "queued" | "running" | "success" | "failed";

export interface RunnerConfig {
  mode: RunnerMode;
  hostname: string;
  port: number;
  dataDir: string;
  runsFile: string;
  workDir: string;
  maxConcurrentRuns: number;
  stepTimeoutMs: number;
}

export interface RunStepInput {
  name: string;
  run: string;
}

export interface RunRequest {
  workflowName: string;
  repository: string;
  ref: string;
  sha?: string;
  env?: Record<string, string>;
  steps: RunStepInput[];
}

export interface StepResult {
  name: string;
  command: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  repository: string;
  ref: string;
  sha?: string;
  env: Record<string, string>;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stepResults: StepResult[];
}

export interface RunStore {
  listRuns(): WorkflowRun[];
  getRun(id: string): WorkflowRun | undefined;
  createRun(run: WorkflowRun): WorkflowRun;
  updateRun(id: string, updater: (run: WorkflowRun) => WorkflowRun): WorkflowRun;
}

export interface RunnerService {
  queueRun(request: RunRequest): WorkflowRun;
  listRuns(): WorkflowRun[];
  getRun(id: string): WorkflowRun | undefined;
  getState(): {
    runningCount: number;
    queuedCount: number;
    maxConcurrentRuns: number;
  };
}
