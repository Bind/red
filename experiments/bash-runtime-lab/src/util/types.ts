export type AppMode = "dev" | "compose";
export type RunStatus = "completed" | "failed";
export type CommandPhase = "before" | "after";

export type FileMutation = {
  path: string;
  kind: "created" | "updated" | "deleted";
  beforeHash?: string;
  afterHash?: string;
};

export type EnvDelta = {
  set: Record<string, string>;
  unset: string[];
};

export type CommandNodeMetadata = {
  nodeId: string;
  commandName: string;
  commandText: string;
  line: number;
};

export type CommandJournalEvent = {
  seq: number;
  phase: CommandPhase;
  cached: boolean;
  nodeId: string;
  visit: number;
  commandName: string;
  commandText: string;
  line: number;
  cwd: string;
  env: Record<string, string>;
  envDelta?: EnvDelta;
  exitCode?: number;
  fileMutations?: FileMutation[];
  at: string;
};

export type RunRecord = {
  runId: string;
  script: string;
  dependencyHashes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  journal: CommandJournalEvent[];
  transformedScript?: string;
  commandNodes: Record<string, CommandNodeMetadata>;
  lastResult?: RunResult;
};

export type RunResult = {
  runId: string;
  status: RunStatus;
  stdout: string;
  stderr: string;
  exitCode: number;
  journal: CommandJournalEvent[];
  commandCount: number;
  startedAt: string;
  completedAt: string;
};

export type ExecuteRunRequest = {
  runId: string;
  script: string;
  env: Record<string, string>;
  dependencyHashes?: Record<string, string>;
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
  ensureRun(
    runId: string,
    script: string,
    workspaceDir: string,
    dependencyHashes: Record<string, string>,
  ): Promise<RunRecord>;
  saveRun(record: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
}
