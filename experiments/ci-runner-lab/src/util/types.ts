export type RunnerMode = "dev" | "compose";
export type QueueClass = "default";
export type AttemptStatus =
  | "queued"
  | "redeeming_credentials"
  | "starting"
  | "running"
  | "uploading_results"
  | "success"
  | "failed";
export type AttemptFailureClass =
  | "job_failed"
  | "bootstrap_failed"
  | "image_failed"
  | "artifact_upload_failed"
  | "system_failed";

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

export interface JobSpec {
  jobId: string;
  repoId: string;
  commitSha: string;
  jobName: string;
  env: Record<string, string>;
  createdAt: string;
}

export interface AttemptLogChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "display";
  text: string;
  createdAt: string;
}

export interface AttemptRecord {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  queueClass: QueueClass;
  routingKey: string;
  status: AttemptStatus;
  gitCredentialGrantFingerprint: string;
  leasedByWorkerId?: string;
  leaseStartedAt?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  executionId?: string;
  exitCode?: number;
  failureClass?: AttemptFailureClass;
  failureMessage?: string;
  logs: AttemptLogChunk[];
  artifacts: string[];
}

export interface JobRecord {
  job: JobSpec;
  attempts: AttemptRecord[];
}

export interface CreateJobRequest {
  repoId: string;
  commitSha: string;
  jobName: string;
  env?: Record<string, string>;
  gitCredentialGrant: string;
}

export interface RetryJobRequest {
  gitCredentialGrant: string;
}

export interface QueueItem {
  job: JobSpec;
  attempt: AttemptRecord;
  requirements: ExecutionRequirements;
}

export interface ExecutionRequirements {
  queueClass: QueueClass;
  network: "default";
  gitAccess: "read";
  workspace: "ephemeral_rw";
  baseImage: "ci-runner-default";
  timeoutClass: "default";
}

export interface WorkerCapabilities {
  queueClasses: QueueClass[];
  gitAccessModes: Array<"read">;
  workspaceModes: Array<"ephemeral_rw">;
  networkModes: Array<"default">;
  timeoutClasses: Array<"default">;
  baseImages: Array<"ci-runner-default">;
}

export interface ExecutionBundle {
  attemptId: string;
  jobId: string;
  repoId: string;
  commitSha: string;
  jobName: string;
  timeoutMs: number;
  workspaceDir: string;
  artifactsDir: string;
  env: Record<string, string>;
}

export interface ExecutionHandle {
  backendExecutionId: string;
}

export interface ExecutionStatus {
  phase: "starting" | "running" | "succeeded" | "failed";
  exitCode?: number;
}

export interface LogReadResult {
  chunks: Array<{
    stream: "stdout" | "stderr";
    text: string;
  }>;
  cursor: number;
}

export interface FileEntry {
  path: string;
  size: number;
  isSymlink: boolean;
}

export interface AttemptResult {
  attemptId: string;
  exitCode: number;
  failureClass?: AttemptFailureClass;
  failureMessage?: string;
  artifacts: string[];
}

export interface AttemptQueue {
  enqueue(item: QueueItem): void;
  lease(workerId: string, capabilities: WorkerCapabilities): QueueItem | undefined;
}

export interface ExecutorBackend {
  start(bundle: ExecutionBundle): Promise<ExecutionHandle>;
  status(handle: ExecutionHandle): Promise<ExecutionStatus>;
  readLogs(handle: ExecutionHandle, cursor: number): Promise<LogReadResult>;
  listFiles(handle: ExecutionHandle, containerPath: string): Promise<FileEntry[]>;
}

export interface Worker {
  tick(): Promise<boolean>;
  getState(): {
    workerId: string;
    runningAttemptId?: string;
  };
}

export interface JobStore {
  listJobs(): JobRecord[];
  getJob(jobId: string): JobRecord | undefined;
  getAttempt(attemptId: string): { job: JobSpec; attempt: AttemptRecord } | undefined;
  createJob(job: JobSpec, attempt: AttemptRecord): JobRecord;
  createRetryAttempt(jobId: string, attempt: AttemptRecord): JobRecord;
  updateAttempt(
    attemptId: string,
    updater: (attempt: AttemptRecord, job: JobSpec) => AttemptRecord,
  ): AttemptRecord;
}

export interface JobsService {
  createJob(request: CreateJobRequest): JobRecord;
  retryJob(jobId: string, request: RetryJobRequest): JobRecord;
  listJobs(): JobRecord[];
  getJob(jobId: string): JobRecord | undefined;
  getAttemptLogChunks(
    jobId: string,
    attemptNumber: number,
    afterSequence: number,
  ): AttemptLogChunk[];
  getState(): {
    queuedCount: number;
    worker: {
      workerId: string;
      runningAttemptId?: string;
    };
  };
  tickWorker(): Promise<boolean>;
}
