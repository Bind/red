export interface MirrorRepoConfig {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  trackedRef: string;
  pollIntervalMs?: number;
}

export interface CanaryConfig {
  mode: "dev" | "compose";
  hostname: string;
  port: number;
  pollIntervalMs: number;
  dataDir: string;
  cacheDir: string;
  stateDbPath: string;
  repos: MirrorRepoConfig[];
  eventWebhookUrl?: string;
}

export interface RepoStatusRecord {
  repoId: string;
  trackedRef: string;
  lastRunStatus: "success" | "error" | "idle";
  lastSourceHead?: string;
  lastTargetHead?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
}

export interface CanaryEvent {
  id: string;
  repoId: string;
  type: "mirror_succeeded" | "mirror_issue" | "source_advanced";
  severity: "info" | "error";
  occurredAt: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MirrorStateStore {
  init(): void;
  getRepoStatus(repoId: string): RepoStatusRecord | null;
  upsertRepoStatus(record: RepoStatusRecord): void;
  appendEvent(event: CanaryEvent): void;
  listRepoStatuses(): RepoStatusRecord[];
  listEvents(limit: number): CanaryEvent[];
}

export interface MirrorEventPublisher {
  publish(event: CanaryEvent): Promise<void>;
}

export interface MirrorGitClient {
  ensureLocalMirror(repo: MirrorRepoConfig, cacheDir: string): Promise<string>;
  resolveLocalRef(cachePath: string, ref: string): Promise<string>;
  pushMirror(cachePath: string, repo: MirrorRepoConfig): Promise<void>;
  resolveRemoteRef(repo: MirrorRepoConfig): Promise<string>;
}

export interface Clock {
  now(): Date;
}
