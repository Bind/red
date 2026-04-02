export interface ClawOutputSpec {
  json?: boolean;
  files?: string[];
}

export type ClawRunStatus = "created" | "running" | "completed" | "failed";

export interface ClawRunMetadata {
  runId?: string;
  jobName: string;
  jobId?: string;
  changeId?: number;
  workerId?: string;
}

export interface ClawRepoRunRequest<TJson = unknown> {
  repo: string;
  headRef: string;
  baseRef?: string;
  instructions: string;
  setupScript?: string;
  output: ClawOutputSpec;
  metadata: ClawRunMetadata;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  parseJson?: (raw: unknown) => TJson;
}

export interface ClawOutputFile {
  path: string;
  content: string;
}

export interface ClawRunError {
  type:
    | "local_environment_failed"
    | "docker_failed"
    | "timeout"
    | "missing_json"
    | "invalid_json"
    | "missing_file"
    | "runtime_error";
  message: string;
}

export interface ClawRepoRunResult<TJson = unknown> {
  ok: boolean;
  runId: string;
  status: ClawRunStatus;
  durationMs: number;
  logs: string;
  json?: TJson;
  files: ClawOutputFile[];
  containerName: string;
  containerId?: string;
  error?: ClawRunError;
}

export interface ClawRunRecord {
  runId: string;
  jobName: string;
  jobId: string | null;
  changeId: number | null;
  workerId: string | null;
  repo: string;
  headRef: string;
  baseRef: string | null;
  image: string;
  containerName: string;
  containerId: string | null;
  codexSessionId: string | null;
  rolloutPath: string | null;
  status: ClawRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

export interface ClawRunnerConfig {
  image: string;
  forgejoBaseUrl: string;
  openaiApiKey: string | null;
  defaultTimeoutMs?: number;
  tracker?: ClawRunTracker;
  artifactStore?: ClawArtifactStore;
}

export interface ClawJobDefinition<TInput, TJson = unknown> {
  name: string;
  description: string;
  build(input: TInput): ClawRepoRunRequest<TJson>;
}

export interface ManualClawJob<TInput, TJson = unknown>
  extends ClawJobDefinition<TInput, TJson> {
  parseCliArgs(args: string[]): TInput;
}

export interface ClawRunTracker {
  create(record: ClawRunRecord): void;
  markRunning(runId: string, containerId: string | null, startedAt: string): void;
  attachRollout(runId: string, codexSessionId: string | null, rolloutPath: string | null): void;
  finish(
    runId: string,
    params: {
      status: Extract<ClawRunStatus, "completed" | "failed">;
      finishedAt: string;
      durationMs: number;
      errorType?: string | null;
      errorMessage?: string | null;
    }
  ): void;
  getByRunId(runId: string): ClawRunRecord | null;
  listRecent(limit?: number): ClawRunRecord[];
  listByStatus(status: ClawRunRecord["status"], limit?: number): ClawRunRecord[];
}

export interface PersistedClawArtifacts {
  baseKey: string;
  requestKey: string | null;
  resultKey: string | null;
  eventsKey: string | null;
  filesPrefix: string;
  rolloutPath: string | null;
}

export interface ClawArtifactStore {
  persistRunArtifacts(
    runId: string,
    inputDir: string,
    outputDir: string
  ): Promise<PersistedClawArtifacts>;
  readTextArtifact(
    runId: string,
    kind: "request" | "result" | "events"
  ): Promise<string | null>;
}
