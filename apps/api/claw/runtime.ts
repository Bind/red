export type AgentRuntimeStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRuntimeEventKind =
  | "lifecycle"
  | "message"
  | "artifact"
  | "custom";

export interface AgentRuntimeIdentity {
  runId: string;
  jobName: string;
  jobId?: string;
  changeId?: number;
  workerId?: string;
}

export interface AgentRuntimeWorkspace {
  repo: string;
  headRef: string;
  baseRef?: string;
  setupScript?: string;
}

export interface AgentRuntimePrompt {
  actionId: string;
  promptName: string;
  promptHash: string;
  instructions: string;
}

export interface AgentRuntimeOutputContract<TJson = unknown> {
  expectJson?: boolean;
  expectedFiles?: string[];
  parseJson?: (raw: unknown) => TJson;
}

export interface AgentRuntimeRunRequest<TJson = unknown> {
  identity: AgentRuntimeIdentity;
  workspace: AgentRuntimeWorkspace;
  prompt: AgentRuntimePrompt;
  output: AgentRuntimeOutputContract<TJson>;
  timeoutMs?: number;
}

export interface AgentRuntimeEvent {
  id: string;
  runId: string;
  runtimeSessionId?: string;
  timestamp: string;
  sequence: number;
  kind: AgentRuntimeEventKind;
  type: string;
  status?: AgentRuntimeStatus;
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  delta?: string;
  data?: Record<string, unknown>;
  raw?: unknown;
}

export interface AgentRuntimeFileArtifact {
  path: string;
  content: string;
}

export interface AgentRuntimeRunResult<TJson = unknown> {
  status: Extract<AgentRuntimeStatus, "completed" | "failed" | "cancelled">;
  runtimeSessionId?: string;
  durationMs: number;
  json?: TJson;
  files: AgentRuntimeFileArtifact[];
  errorType?: string;
  errorMessage?: string;
}

export interface AgentRuntimeSession<TJson = unknown> {
  identity: AgentRuntimeIdentity;
  events: AsyncIterable<AgentRuntimeEvent>;
  result(): Promise<AgentRuntimeRunResult<TJson>>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentRuntime {
  startRun<TJson = unknown>(
    request: AgentRuntimeRunRequest<TJson>
  ): Promise<AgentRuntimeSession<TJson>>;
}
