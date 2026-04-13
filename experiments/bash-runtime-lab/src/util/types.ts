export type AppMode = "dev" | "compose";

export type SegmentType = "ephemeral" | "durable";
export type RunStatus = "completed" | "failed" | "interrupted";

export type ScriptSegment = {
  type: SegmentType;
  id: string;
  script: string;
  startLine: number;
  endLine: number;
};

export type ChunkExecution = {
  segmentId: string;
  type: SegmentType;
  cached: boolean;
  status: "completed" | "failed" | "skipped";
  exitCode: number;
  stdout: string;
  stderr: string;
  hash: string;
  startedAt: string;
  completedAt: string;
  startLine: number;
  endLine: number;
};

export type ChunkRecord = {
  chunkId: string;
  hash: string;
  status: "completed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
};

export type RunRecord = {
  runId: string;
  script: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  kv: Record<string, string>;
  chunks: Record<string, ChunkRecord>;
  lastResult?: RunResult;
};

export type RunResult = {
  runId: string;
  status: RunStatus;
  executions: ChunkExecution[];
  startedAt: string;
  completedAt: string;
};

export type ExecuteRunRequest = {
  runId: string;
  script: string;
  env: Record<string, string>;
  interruptAfterChunk?: string;
};

export type ExecuteRunResponse = {
  ok: true;
  result: RunResult;
};

export type BashRuntimeConfig = {
  mode: AppMode;
  host: string;
  port: number;
  dataDir: string;
  runsDir: string;
  workspacesDir: string;
};

export interface RunStore {
  ensureRun(runId: string, script: string, workspaceDir: string): Promise<RunRecord>;
  saveRun(record: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
}
