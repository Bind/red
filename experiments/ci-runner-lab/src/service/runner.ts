import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AttemptQueue,
  AttemptRecord,
  AttemptResult,
  AttemptStatus,
  CreateJobRequest,
  ExecutionBundle,
  ExecutorBackend,
  JobRecord,
  JobSpec,
  JobStore,
  JobsService,
  QueueItem,
  RetryJobRequest,
  RunnerConfig,
  Worker,
  WorkerCapabilities,
} from "../util/types";

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: "job" | "attempt"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function fingerprint(secret: string): string {
  return `sha256:${Bun.hash(secret).toString(16)}`;
}

function buildRoutingKey(job: Pick<JobSpec, "repoId" | "jobName">): string {
  return `${job.repoId}:${job.jobName}`;
}

function validateEnv(value: Record<string, string> | undefined): Record<string, string> {
  const env = value ?? {};
  for (const key of Object.keys(env)) {
    if (!/^JOB_[A-Z0-9_]+$/.test(key)) {
      throw new Error(`env ${key} must match JOB_[A-Z0-9_]+`);
    }
  }
  return env;
}

function validateCommitSha(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("commitSha must be a 40-character lowercase hex SHA");
  }
  return normalized;
}

function validateRepoId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("repoId must match owner/repo");
  }
  return normalized;
}

function validateJobName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error("jobName must match ^[a-z0-9][a-z0-9-]*$");
  }
  return normalized;
}

function requiredGrant(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("gitCredentialGrant is required");
  }
  return normalized;
}

function userStatus(status: AttemptStatus): "queued" | "running" | "success" | "failed" {
  if (status === "success") {
    return "success";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "queued") {
    return "queued";
  }
  return "running";
}

export class LocalAttemptQueue implements AttemptQueue {
  private readonly queuedAttemptIds: string[] = [];

  constructor(private readonly store: JobStore) {}

  enqueue(item: QueueItem): void {
    this.queuedAttemptIds.push(item.attempt.attemptId);
  }

  lease(workerId: string, capabilities: WorkerCapabilities): QueueItem | undefined {
    while (this.queuedAttemptIds.length > 0) {
      const attemptId = this.queuedAttemptIds.shift();
      if (!attemptId) {
        return undefined;
      }

      const record = this.store.getAttempt(attemptId);
      if (!record) {
        continue;
      }

      const { job, attempt } = record;
      if (!capabilities.queueClasses.includes(attempt.queueClass)) {
        continue;
      }

      const leased = this.store.updateAttempt(attemptId, (current) => ({
        ...current,
        leasedByWorkerId: workerId,
        leaseStartedAt: nowIso(),
      }));

      return {
        job,
        attempt: leased,
        requirements: {
          queueClass: leased.queueClass,
          network: "default",
          gitAccess: "read",
          workspace: "ephemeral_rw",
          baseImage: "ci-runner-default",
          timeoutClass: "default",
        },
      };
    }

    return undefined;
  }

  size(): number {
    return this.queuedAttemptIds.length;
  }
}

export class LocalWorker implements Worker {
  private readonly capabilities: WorkerCapabilities = {
    queueClasses: ["default"],
    gitAccessModes: ["read"],
    workspaceModes: ["ephemeral_rw"],
    networkModes: ["default"],
    timeoutClasses: ["default"],
    baseImages: ["ci-runner-default"],
  };
  private runningAttemptId?: string;

  constructor(
    private readonly workerId: string,
    private readonly config: RunnerConfig,
    private readonly store: JobStore,
    private readonly queue: LocalAttemptQueue,
    private readonly backend: ExecutorBackend,
  ) {}

  getState() {
    return {
      workerId: this.workerId,
      runningAttemptId: this.runningAttemptId,
    };
  }

  async tick(): Promise<boolean> {
    if (this.runningAttemptId) {
      return false;
    }

    const item = this.queue.lease(this.workerId, this.capabilities);
    if (!item) {
      return false;
    }

    this.runningAttemptId = item.attempt.attemptId;
    try {
      await this.execute(item);
      return true;
    } finally {
      this.runningAttemptId = undefined;
    }
  }

  private async execute(item: QueueItem) {
    const attemptId = item.attempt.attemptId;
    const workspaceDir = join(this.config.workDir, attemptId, "repo");
    const artifactsDir = join(this.config.workDir, attemptId, "artifacts");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    this.transition(attemptId, "redeeming_credentials");
    await Bun.sleep(10);
    this.transition(attemptId, "starting");

    const env = {
      ...item.job.env,
      CI_ATTEMPT_ID: item.attempt.attemptId,
      CI_ATTEMPT_NUMBER: `${item.attempt.attemptNumber}`,
      CI_JOB_ID: item.job.jobId,
      CI_JOB_NAME: item.job.jobName,
      CI_REPO_ID: item.job.repoId,
      CI_COMMIT_SHA: item.job.commitSha,
      CI_WORKSPACE_DIR: workspaceDir,
      CI_ARTIFACTS_DIR: artifactsDir,
      CI_GIT_HELPER_PATH: "/run/redc/git-credential-helper",
      CI_INLINE_COMMAND: [
        `echo "repo ${item.job.repoId}"`,
        `echo "commit ${item.job.commitSha}"`,
        `echo "job ${item.job.jobName}"`,
        `echo "ready" > "$CI_ARTIFACTS_DIR/result.txt"`,
        `cat "$CI_ARTIFACTS_DIR/result.txt"`,
        `echo "grant ${item.attempt.gitCredentialGrantFingerprint}" >/dev/null`,
      ].join(" && "),
    };

    this.validateBootstrapEnv(env);

    const bundle: ExecutionBundle = {
      attemptId: item.attempt.attemptId,
      jobId: item.job.jobId,
      repoId: item.job.repoId,
      commitSha: item.job.commitSha,
      jobName: item.job.jobName,
      timeoutMs: this.config.stepTimeoutMs,
      workspaceDir,
      artifactsDir,
      env,
    };

    const handle = await this.backend.start(bundle);
    this.store.updateAttempt(attemptId, (attempt) => ({
      ...attempt,
      executionId: handle.backendExecutionId,
    }));
    this.transition(attemptId, "running");

    let cursor = 0;
    let terminalStatus: AttemptStatus | undefined;
    let exitCode = 1;

    while (!terminalStatus) {
      const logs = await this.backend.readLogs(handle, cursor);
      cursor = logs.cursor;
      for (const chunk of logs.chunks) {
        this.appendLogChunk(attemptId, chunk.stream, chunk.text);
      }

      const status = await this.backend.status(handle);
      if (status.phase === "succeeded") {
        terminalStatus = "success";
        exitCode = status.exitCode ?? 0;
      } else if (status.phase === "failed") {
        terminalStatus = "failed";
        exitCode = status.exitCode ?? 1;
      } else {
        await Bun.sleep(25);
      }
    }

    this.transition(attemptId, "uploading_results");
    const files = await this.backend.listFiles(handle, artifactsDir);
    const result: AttemptResult = {
      attemptId,
      exitCode,
      failureClass: terminalStatus === "failed" ? "job_failed" : undefined,
      artifacts: files
        .filter((file) => !file.isSymlink)
        .map(
          (file) =>
            `ci/jobs/${item.job.jobId}/attempts/${item.attempt.attemptNumber}/artifacts/${file.path}`,
        ),
    };

    this.finishAttempt(result);
  }

  private validateBootstrapEnv(env: Record<string, string>) {
    const required = [
      "CI_ATTEMPT_ID",
      "CI_ATTEMPT_NUMBER",
      "CI_JOB_ID",
      "CI_JOB_NAME",
      "CI_REPO_ID",
      "CI_COMMIT_SHA",
      "CI_WORKSPACE_DIR",
      "CI_ARTIFACTS_DIR",
      "CI_GIT_HELPER_PATH",
    ];

    for (const key of required) {
      if (!env[key]?.trim()) {
        throw new Error(`${key} is required`);
      }
    }
  }

  private transition(attemptId: string, status: AttemptStatus) {
    this.store.updateAttempt(attemptId, (attempt) => ({
      ...attempt,
      status,
      startedAt: status === "running" && !attempt.startedAt ? nowIso() : attempt.startedAt,
    }));
  }

  private appendLogChunk(attemptId: string, stream: "stdout" | "stderr", rawText: string) {
    if (!rawText) {
      return;
    }

    const lines = rawText.includes("\n") ? rawText.split(/(?<=\n)/) : [rawText];
    this.store.updateAttempt(attemptId, (attempt) => {
      let nextSequence = attempt.logs.reduce((max, chunk) => Math.max(max, chunk.sequence), 0) + 1;
      const additions = [];

      for (const text of lines) {
        if (!text) {
          continue;
        }
        additions.push({
          sequence: nextSequence,
          stream,
          text,
          createdAt: nowIso(),
        });
        nextSequence += 1;
        additions.push({
          sequence: nextSequence,
          stream: "display" as const,
          text: `[${stream}] ${text}`,
          createdAt: nowIso(),
        });
        nextSequence += 1;
      }

      return {
        ...attempt,
        logs: [...attempt.logs, ...additions],
      };
    });
  }

  private finishAttempt(result: AttemptResult) {
    this.store.updateAttempt(result.attemptId, (attempt) => ({
      ...attempt,
      status: result.failureClass ? "failed" : "success",
      exitCode: result.exitCode,
      failureClass: result.failureClass,
      failureMessage: result.failureMessage,
      artifacts: result.artifacts,
      finishedAt: nowIso(),
    }));
  }
}

export class LocalJobsService implements JobsService {
  constructor(
    private readonly store: JobStore,
    private readonly queue: LocalAttemptQueue,
    private readonly worker: Worker,
  ) {}

  createJob(request: CreateJobRequest): JobRecord {
    const job: JobSpec = {
      jobId: createId("job"),
      repoId: validateRepoId(request.repoId),
      commitSha: validateCommitSha(request.commitSha),
      jobName: validateJobName(request.jobName),
      env: validateEnv(request.env),
      createdAt: nowIso(),
    };
    const attempt: AttemptRecord = {
      attemptId: createId("attempt"),
      jobId: job.jobId,
      attemptNumber: 1,
      queueClass: "default",
      routingKey: buildRoutingKey(job),
      status: "queued",
      gitCredentialGrantFingerprint: fingerprint(requiredGrant(request.gitCredentialGrant)),
      queuedAt: nowIso(),
      logs: [],
      artifacts: [],
    };

    const record = this.store.createJob(job, attempt);
    this.queue.enqueue({
      job,
      attempt,
      requirements: {
        queueClass: "default",
        network: "default",
        gitAccess: "read",
        workspace: "ephemeral_rw",
        baseImage: "ci-runner-default",
        timeoutClass: "default",
      },
    });
    return record;
  }

  retryJob(jobId: string, request: RetryJobRequest): JobRecord {
    const record = this.store.getJob(jobId);
    if (!record) {
      throw new Error("job not found");
    }

    const attempt: AttemptRecord = {
      attemptId: createId("attempt"),
      jobId,
      attemptNumber: record.attempts.length + 1,
      queueClass: "default",
      routingKey: buildRoutingKey(record.job),
      status: "queued",
      gitCredentialGrantFingerprint: fingerprint(requiredGrant(request.gitCredentialGrant)),
      queuedAt: nowIso(),
      logs: [],
      artifacts: [],
    };

    const updated = this.store.createRetryAttempt(jobId, attempt);
    this.queue.enqueue({
      job: updated.job,
      attempt,
      requirements: {
        queueClass: "default",
        network: "default",
        gitAccess: "read",
        workspace: "ephemeral_rw",
        baseImage: "ci-runner-default",
        timeoutClass: "default",
      },
    });
    return updated;
  }

  listJobs(): JobRecord[] {
    return this.store.listJobs();
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.store.getJob(jobId);
  }

  getAttemptLogChunks(jobId: string, attemptNumber: number, afterSequence: number) {
    const record = this.store.getJob(jobId);
    const attempt = record?.attempts.find((entry) => entry.attemptNumber === attemptNumber);
    return attempt?.logs.filter((chunk) => chunk.sequence > afterSequence) ?? [];
  }

  getState() {
    return {
      queuedCount: this.queue.size(),
      worker: this.worker.getState(),
    };
  }

  async tickWorker() {
    return await this.worker.tick();
  }
}

export function summarizeJob(record: JobRecord) {
  const latestAttempt = [...record.attempts].sort(
    (left, right) => right.attemptNumber - left.attemptNumber,
  )[0];
  return {
    jobId: record.job.jobId,
    repoId: record.job.repoId,
    commitSha: record.job.commitSha,
    jobName: record.job.jobName,
    createdAt: record.job.createdAt,
    latestAttempt: latestAttempt
      ? {
          attemptId: latestAttempt.attemptId,
          attemptNumber: latestAttempt.attemptNumber,
          status: userStatus(latestAttempt.status),
          internalStatus: latestAttempt.status,
          failureClass: latestAttempt.failureClass ?? null,
          queuedAt: latestAttempt.queuedAt,
          startedAt: latestAttempt.startedAt ?? null,
          finishedAt: latestAttempt.finishedAt ?? null,
        }
      : null,
  };
}
