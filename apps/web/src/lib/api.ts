import { hc } from "hono/client";
import superjson from "superjson";
import type { AppType } from "../../../bff/src/app";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@/lib/webauthn";

export type ChangeStatus =
  | "pushed"
  | "scoring"
  | "scored"
  | "summarizing"
  | "ready_for_review"
  | "superseded";

export type ConfidenceLevel = "safe" | "needs_review" | "critical";
export type CreatedBy = "human" | "agent";

export interface DiffStats {
  files_changed: number;
  additions: number;
  deletions: number;
}

export interface Change {
  id: number;
  org_id: string;
  repo: string;
  branch: string;
  base_branch: string;
  head_sha: string;
  status: ChangeStatus;
  confidence: ConfidenceLevel | null;
  created_by: CreatedBy;
  summary: string | null;
  diff_stats: DiffStats | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeEvent {
  id: number;
  change_id: number;
  event_type: string;
  from_status: ChangeStatus | null;
  to_status: ChangeStatus | null;
  metadata: string | null;
  created_at: string;
}

export interface ChangeDetail extends Change {
  events: ChangeEvent[];
}

export interface Velocity {
  summarized: number;
  pending_review: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type AuthOnboardingState = "pending_passkey" | "pending_recovery_factor" | "active";

export interface AuthSessionInfo {
  id: string;
  sessionKind?: string | null;
  secondFactorVerified?: boolean | null;
}

export interface AuthUserInfo {
  id: string;
  email: string;
  name?: string | null;
  onboardingState?: AuthOnboardingState | string | null;
  recoveryReady?: boolean | null;
  recoveryChallengePending?: boolean | null;
  authAssurance?: string | null;
  twoFactorEnabled?: boolean | null;
}

export interface AuthMeResponse {
  session: AuthSessionInfo;
  user: AuthUserInfo;
}

export interface MagicLinkPreview {
  email: string;
  token: string;
  url: string;
  purpose?: string;
}

export interface LoginAttempt {
  attempt_id: string;
  client_id: string;
  status: "pending" | "completed" | "redeemed" | "expired";
  expires_at?: string;
  session_id?: string | null;
  login_grant?: string;
}

export interface TotpEnrollment {
  totpURI: string;
  backupCodes: string[];
}

export type RepoVisibility = "private" | "internal" | "public";

export interface RepoSummary {
  id?: number | string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  visibility?: RepoVisibility;
  created_at?: string;
  updated_at?: string;
}

export interface HostedRepoBranch {
  name: string;
  sha: string;
  message: string;
  timestamp: string | null;
  protected: boolean;
}

export interface HostedRepoCommit {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  timestamp: string | null;
}

export interface HostedRepoSnapshot {
  repo: RepoSummary;
  readme: {
    path: string;
    content: string;
  } | null;
  branches: HostedRepoBranch[];
  commits: HostedRepoCommit[];
  access: {
    actor_id: string;
    mode: "read";
    token_ttl_seconds: number;
  };
  availability: {
    reachable: boolean;
    error: string | null;
  };
  fetched_at: string;
}

export interface CreateRepoInput {
  owner: string;
  name: string;
  defaultBranch?: string;
  visibility?: RepoVisibility;
}

const client = hc<AppType>("/") as any;

function decodeResponseBody<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) return null as T;
  const raw = JSON.parse(trimmed) as unknown;
  if (
    raw
    && typeof raw === "object"
    && "json" in (raw as Record<string, unknown>)
  ) {
    return superjson.deserialize(raw as any) as T;
  }
  return raw as T;
}

async function rpcJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body || `API error: ${response.status}`, response.status);
  }
  return decodeResponseBody<T>(await response.text());
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body || `API error: ${response.status}`, response.status);
  }
  return decodeResponseBody<T>(await response.text());
}

function normalizeRepoSummary(repo: unknown): RepoSummary | null {
  if (typeof repo === "string") {
    const [owner, name] = repo.split("/", 2);
    if (!owner || !name) return null;
    return {
      owner,
      name,
      full_name: `${owner}/${name}`,
      default_branch: "main",
    };
  }

  if (!repo || typeof repo !== "object") return null;
  const value = repo as Record<string, unknown>;
  const fullName =
    typeof value.full_name === "string"
      ? value.full_name
      : typeof value.fullName === "string"
        ? value.fullName
        : "";
  const owner =
    typeof value.owner === "string"
      ? value.owner
      : fullName.includes("/")
        ? fullName.split("/")[0] ?? ""
        : "";
  const name =
    typeof value.name === "string"
      ? value.name
      : fullName.includes("/")
        ? fullName.split("/", 2)[1] ?? ""
        : "";
  const defaultBranch =
    typeof value.default_branch === "string"
      ? value.default_branch
      : typeof value.defaultBranch === "string"
        ? value.defaultBranch
        : "main";

  if (!owner || !name) return null;

  return {
    id: typeof value.id === "string" || typeof value.id === "number" ? value.id : undefined,
    owner,
    name,
    full_name: fullName || `${owner}/${name}`,
    default_branch: defaultBranch,
    visibility:
      value.visibility === "private" || value.visibility === "internal" || value.visibility === "public"
        ? value.visibility
        : undefined,
    created_at: typeof value.created_at === "string" ? value.created_at : undefined,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
  };
}

function normalizeRepoSummaries(payload: unknown): RepoSummary[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeRepoSummary).filter((repo): repo is RepoSummary => repo !== null);
  }
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    if (Array.isArray(value.repos)) {
      return value.repos
        .map(normalizeRepoSummary)
        .filter((repo): repo is RepoSummary => repo !== null);
    }
  }
  return [];
}

export async function fetchMe(): Promise<AuthMeResponse> {
  try {
    return await requestJson<AuthMeResponse>("/rpc/me");
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
      throw new ApiError("Missing auth session", error.status);
    }
    throw error;
  }
}

export async function createLoginAttempt(email: string, clientId: string): Promise<LoginAttempt> {
  return requestJson<LoginAttempt>("/rpc/auth/login-attempts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      client_id: clientId,
    }),
  });
}

export async function fetchLatestMagicLink(email: string): Promise<MagicLinkPreview | null> {
  try {
    return await requestJson<MagicLinkPreview>(
      `/rpc/dev/magic-link?email=${encodeURIComponent(email)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function fetchLoginAttempt(attemptId: string): Promise<LoginAttempt> {
  return requestJson<LoginAttempt>(`/rpc/auth/login-attempts/${encodeURIComponent(attemptId)}`);
}

export async function completeMagicLink(input: {
  attemptId: string;
  token: string;
  clientId: string;
}): Promise<{ ok: boolean; status: string; attempt_id: string; session_id?: string | null }> {
  return requestJson("/rpc/auth/magic-link/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      attempt_id: input.attemptId,
      token: input.token,
      client_id: input.clientId,
    }),
  });
}

export async function redeemLoginAttempt(input: {
  attemptId: string;
  loginGrant: string;
}): Promise<{ ok: boolean; status: string; attempt_id: string; session_id?: string | null }> {
  return requestJson("/rpc/auth/login-attempts/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      attempt_id: input.attemptId,
      login_grant: input.loginGrant,
    }),
  });
}

export async function fetchPasskeyRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return requestJson("/api/auth/passkey/generate-register-options", {
    method: "GET",
  });
}

export async function verifyPasskeyRegistration(response: Record<string, unknown>, name: string) {
  return requestJson<{ credentialID?: string }>("/api/auth/passkey/verify-registration", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      response,
      name,
    }),
  });
}

export async function fetchPasskeyAuthenticateOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return requestJson("/api/auth/passkey/generate-authenticate-options", {
    method: "GET",
  });
}

export async function verifyPasskeyAuthentication(response: Record<string, unknown>) {
  return requestJson("/api/auth/passkey/verify-authentication", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      response,
    }),
  });
}

export async function enrollTotp(): Promise<TotpEnrollment> {
  return requestJson("/rpc/auth/user/two-factor/enroll", {
    method: "POST",
  });
}

export async function verifyTotp(code: string, kind: "totp" | "backup_code" = "totp") {
  return requestJson("/rpc/auth/user/two-factor/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      code,
      kind,
    }),
  });
}

export async function loginWithTotp(email: string, code: string) {
  return requestJson("/rpc/auth/user/totp-login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      code,
    }),
  });
}

export async function completeOnboarding() {
  return requestJson("/rpc/auth/user/onboarding/complete", {
    method: "POST",
  });
}

export function fetchVelocity(hours?: number): Promise<Velocity> {
  return client.rpc.velocity.$get({
      query: hours ? { hours: String(hours) } : {},
    }).then(rpcJson);
}

export function fetchReviewQueue(): Promise<Change[]> {
  return client.rpc.review.$get().then(rpcJson);
}

export function fetchChange(id: number): Promise<ChangeDetail> {
  return client.rpc.changes[":id"].$get({ param: { id: String(id) } }).then(rpcJson);
}

export function fetchPendingJobs(): Promise<{ pending: number }> {
  return client.rpc.jobs.pending.$get().then(rpcJson);
}

export async function fetchDiff(id: number): Promise<string> {
  const res = await fetch(`/rpc/changes/${id}/diff`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.text();
}

export async function regenerateSummary(id: number): Promise<void> {
  const res = await client.rpc.changes[":id"]["regenerate-summary"].$post({
    param: { id: String(id) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
}

export async function requeueSummary(id: number): Promise<void> {
  const res = await client.rpc.changes[":id"]["requeue-summary"].$post({
    param: { id: String(id) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
}

export async function fetchRepos(): Promise<RepoSummary[]> {
  try {
    const payload = await requestJson<unknown>("/rpc/repos");
    return normalizeRepoSummaries(payload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return [];
    }
    throw error;
  }
}

export async function fetchHostedRepoSnapshot(repoId?: string): Promise<HostedRepoSnapshot> {
  const suffix = repoId ? `?repo=${encodeURIComponent(repoId)}` : "";
  const payload = await requestJson<HostedRepoSnapshot>(`/rpc/app/hosted-repo${suffix}`);
  return {
    ...payload,
    repo: normalizeRepoSummary(payload.repo) ?? payload.repo,
  };
}

export async function fetchHostedRepoCommitDiff(sha: string, repoId?: string): Promise<string> {
  const suffix = repoId ? `?repo=${encodeURIComponent(repoId)}` : "";
  const res = await fetch(`/rpc/app/hosted-repo/commits/${encodeURIComponent(sha)}/diff${suffix}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.text();
}

export async function fetchHostedRepoTree(ref?: string, repoId?: string): Promise<string[]> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (repoId) params.set("repo", repoId);
  const res = await requestJson<{ files: string[] }>(`/rpc/app/hosted-repo/tree?${params}`);
  return res.files;
}

export async function fetchHostedRepoFile(
  path: string,
  ref?: string,
  repoId?: string,
): Promise<string | null> {
  const params = new URLSearchParams({ path });
  if (ref) params.set("ref", ref);
  if (repoId) params.set("repo", repoId);
  const res = await fetch(`/rpc/app/hosted-repo/file?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const body = await res.json() as { content: string | null };
  return body.content;
}

export async function createRepo(input: CreateRepoInput): Promise<RepoSummary> {
  try {
    const payload = await requestJson<unknown>("/rpc/repos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: input.owner,
        name: input.name,
        defaultBranch: input.defaultBranch ?? "main",
        default_branch: input.defaultBranch ?? "main",
        visibility: input.visibility ?? "private",
      }),
    });
    const repo = normalizeRepoSummary(payload);
    if (!repo) {
      throw new ApiError("Repo response missing required fields", 500);
    }
    return repo;
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      throw new ApiError("Repo creation endpoint is not available yet.", error.status);
    }
    throw error;
  }
}

export interface Branch {
  name: string;
  commit: { id: string; message: string; timestamp: string };
  change: { id: number; status: ChangeStatus } | null;
}

export function fetchBranches(repo: string): Promise<Branch[]> {
  return client.rpc.branches.$get({ query: { repo } }).then(rpcJson);
}

export type AgentSessionStatus = "running" | "completed" | "failed";

export interface AgentSession {
  id: number;
  change_id: number;
  job_id: number | null;
  job_type: string;
  run_id: string;
  runtime: string;
  runtime_session_id: string | null;
  status: AgentSessionStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface AgentSessionEvent {
  id: number;
  session_id: number;
  seq: number;
  event_id: string;
  kind: string;
  type: string;
  status: string | null;
  role: string | null;
  text: string | null;
  delta: string | null;
  data_json: string | null;
  raw_json: string | null;
  created_at: string;
}

export function fetchSessions(changeId: number): Promise<AgentSession[]> {
  return client.rpc.changes[":id"].sessions.$get({ param: { id: String(changeId) } }).then(rpcJson);
}

export function fetchSessionEvents(sessionId: number, afterSeq: number = 0): Promise<AgentSessionEvent[]> {
  return client.rpc.sessions[":id"].events.$get({
      param: { id: String(sessionId) },
      query: { after: String(afterSeq) },
    }).then(rpcJson);
}

export function subscribeToAgentEvents(
  changeId: number,
  onEvent: (event: AgentSessionEvent) => void,
  onDone: (data?: string) => void,
): () => void {
  const es = new EventSource(`/rpc/changes/${changeId}/agent-events`);

  es.addEventListener("event", (e) => {
    onEvent(JSON.parse(e.data) as AgentSessionEvent);
  });

  es.addEventListener("done", (e) => {
    onDone(e.data || undefined);
    es.close();
  });

  es.onerror = () => {
    es.close();
  };

  return () => es.close();
}

// ── Triage UI: wide events + triage runs ──────────────────────────────────

export interface WideEvent {
  event_id: string;
  request_id: string;
  service: string;
  kind: string;
  ts: string;
  ended_at?: string;
  duration_ms?: number;
  outcome?: "ok" | "error";
  status_code?: number;
  route_name?: string;
  error_name?: string;
  error_message?: string;
  data: Record<string, unknown>;
}

export interface WideRollup {
  request_id: string;
  first_ts: string;
  last_ts: string;
  total_duration_ms: number;
  entry_service: string;
  services: string[];
  route_names: string[];
  request_state: "completed" | "incomplete";
  final_outcome: "ok" | "error" | "unknown";
  final_status_code: number | null;
  event_count: number;
  error_count: number;
  primary_error: Record<string, unknown> | null;
  request: {
    request?: {
      method?: string | null;
      path?: string | null;
      host?: string | null;
      scheme?: string | null;
    } | null;
  };
  events: WideEvent[];
  rolled_up_at: string;
}

export interface RollupListQuery {
  service?: string;
  outcome?: "ok" | "error" | "unknown";
  since?: string;
  limit?: number;
}

export async function fetchRollups(query: RollupListQuery = {}): Promise<{
  rollups: WideRollup[];
  count: number;
}> {
  const params = new URLSearchParams();
  if (query.service) params.set("service", query.service);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.since) params.set("since", query.since);
  if (query.limit) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return requestJson<{ rollups: WideRollup[]; count: number }>(`/rpc/rollups${suffix}`);
}

export async function fetchRollupDetail(requestId: string): Promise<WideRollup> {
  return requestJson<WideRollup>(`/rpc/rollups/${encodeURIComponent(requestId)}`);
}

export interface TriageRunSummary {
  id: string;
  status:
    | "received"
    | "investigating"
    | "plan_ready"
    | "approved"
    | "proposing"
    | "proposal_ready"
    | "rejected"
    | "failed";
  created_at: string;
  updated_at: string;
  rollup: Pick<
    WideRollup,
    "request_id" | "entry_service" | "route_names" | "primary_error"
  >;
  plan?: { hypothesis: string; confidence: string };
  proposal?: { repo_id: string; branch: string; pr_url?: string };
  error?: string;
}

export async function fetchTriageRuns(): Promise<{ runs: TriageRunSummary[] }> {
  return requestJson<{ runs: TriageRunSummary[] }>(`/rpc/triage/runs`);
}

export function subscribeToRollupStream(
  query: RollupListQuery,
  onRollup: (rollup: WideRollup) => void,
  onError?: (message: string) => void,
): () => void {
  const params = new URLSearchParams();
  if (query.service) params.set("service", query.service);
  if (query.outcome) params.set("outcome", query.outcome);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const es = new EventSource(`/rpc/rollups/stream${suffix}`);

  es.addEventListener("rollup", (event) => {
    try {
      onRollup(superjson.parse<WideRollup>(event.data));
    } catch {
      onError?.("rollup stream decode failed");
    }
  });

  es.onerror = () => {
    onError?.("rollup stream disconnected");
  };

  return () => es.close();
}

export type ServiceProbeStatus = "ok" | "error" | "unconfigured";

export interface ServiceStatusProbe {
  service: string;
  url: string | null;
  status: ServiceProbeStatus;
  http_status: number | null;
  latency_ms: number | null;
  checked_at: string;
  body: unknown | null;
  error: string | null;
}

export interface ServiceStatusReport {
  checked_at: string;
  overall_status: "ok" | "degraded";
  services: ServiceStatusProbe[];
}

export interface LogEntry {
  timestamp: string;
  service: string;
  level: string;
  logger: string;
  message: string;
  requestId: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  responseTimeMs: number | null;
  properties: Record<string, unknown>;
  line: Record<string, unknown> | null;
}

export interface LogCount {
  value: string;
  count: number;
}

export interface LogTimelineBucket {
  minute: string;
  total: number;
  errors: number;
  status5xx: number;
}

export interface LogSummary {
  total: number;
  serviceCounts: LogCount[];
  levelCounts: LogCount[];
  statusCounts: LogCount[];
  statusClassCounts: LogCount[];
  timeline: LogTimelineBucket[];
}

export interface LogQueryResult {
  query: {
    service: string | null;
    level: string | null;
    logger: "all" | "http";
    search: string | null;
    window: string;
    limit: number;
    statusCode: number | null;
    statusClass: "2xx" | "3xx" | "4xx" | "5xx" | null;
  };
  entries: LogEntry[];
  summary: LogSummary;
}

export interface LogQueryInput {
  service?: string;
  level?: string;
  logger?: "all" | "http";
  search?: string;
  window?: string;
  limit?: number;
  statusCode?: number;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx";
}

export interface LogStreamInput {
  service?: string;
  level?: string;
  logger?: "all" | "http";
  search?: string;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx";
  historyWindow?: string;
}

export async function fetchStatusReport(): Promise<ServiceStatusReport> {
  const res = await fetch("/rpc/status");
  const body = (await res.json().catch(() => null)) as ServiceStatusReport | null;
  if (!res.ok && !body) {
    throw new ApiError(`status ${res.status}`, res.status);
  }
  if (!body) {
    throw new ApiError("status response missing body", res.status);
  }
  return body;
}

export async function fetchLogs(query: LogQueryInput = {}): Promise<LogQueryResult> {
  const params = new URLSearchParams();
  if (query.service) params.set("service", query.service);
  if (query.level) params.set("level", query.level);
  if (query.logger) params.set("logger", query.logger);
  if (query.search) params.set("search", query.search);
  if (query.window) params.set("window", query.window);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.statusCode !== undefined) params.set("status_code", String(query.statusCode));
  if (query.statusClass) params.set("status_class", query.statusClass);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return requestJson<LogQueryResult>(`/rpc/logs${suffix}`);
}

export function subscribeToLogStream(
  query: LogStreamInput,
  onEntry: (entry: LogEntry) => void,
  onError?: (message: string) => void,
): () => void {
  const params = new URLSearchParams();
  if (query.service) params.set("service", query.service);
  if (query.level) params.set("level", query.level);
  if (query.logger) params.set("logger", query.logger);
  if (query.search) params.set("search", query.search);
  if (query.statusClass) params.set("status_class", query.statusClass);
  if (query.historyWindow) params.set("history_window", query.historyWindow);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const es = new EventSource(`/rpc/logs/stream${suffix}`);

  es.addEventListener("log", (event) => {
    onEntry(JSON.parse(event.data) as LogEntry);
  });

  es.addEventListener("stream-error", (event) => {
    try {
      const payload = JSON.parse(event.data) as { error?: string };
      onError?.(payload.error ?? "log stream failed");
    } catch {
      onError?.("log stream failed");
    }
  });

  es.onerror = () => {
    onError?.("log stream disconnected");
  };

  return () => es.close();
}

export interface DaemonSpec {
  name: string;
  description: string;
  file: string;
  scopeRoot: string;
}

export interface DaemonTrackEntry {
  subject: string;
  fingerprint: string;
  fact: unknown;
  depends_on: string[];
  checked_at: string;
  source_run_id: string;
}

export interface DaemonCheckedFile {
  path: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
}

export interface DaemonMemory {
  daemon: string;
  scopeRoot: string;
  repoId: string;
  commit: string | null;
  updatedAt: string;
  tracked: Record<string, DaemonTrackEntry>;
  lastRun: {
    summary: string;
    nextRunHint?: string;
    findings: Array<{
      invariant: string;
      target?: string;
      status: "ok" | "healed" | "violation_persists" | "skipped";
      note?: string;
    }>;
    checkedFiles: DaemonCheckedFile[];
    fileInventory: DaemonCheckedFile[];
  } | null;
}

export interface DaemonRunIndexEntry {
  runId: string;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  summary?: string;
  reason?: string;
}

export async function fetchDaemons(): Promise<DaemonSpec[]> {
  const res = await requestJson<{ daemons: DaemonSpec[] }>("/rpc/daemons");
  return res.daemons;
}

export async function fetchDaemonMemory(name: string, repoId?: string): Promise<DaemonMemory | null> {
  try {
    const query = repoId ? `?repo=${encodeURIComponent(repoId)}` : "";
    return await requestJson<DaemonMemory>(`/rpc/daemons/${encodeURIComponent(name)}/memory${query}`);
  } catch {
    return null;
  }
}

export async function fetchDaemonRuns(name: string, repoId?: string): Promise<DaemonRunIndexEntry[]> {
  const query = repoId ? `?repo=${encodeURIComponent(repoId)}` : "";
  const res = await requestJson<{ runs: DaemonRunIndexEntry[] }>(`/rpc/daemons/${encodeURIComponent(name)}/runs${query}`);
  return res.runs;
}

export type DaemonPlaygroundProfile = {
  id: string;
  name: string;
  mode:
    | "memory_only"
    | "embedding_only"
    | "memory_embedding"
    | "memory_embedding_librarian";
  routerProvider?: "local" | "openrouter";
  routerModel?: string;
  librarianModel?: string;
};

export type DaemonPlaygroundFileScore = {
  daemonName: string;
  semanticScore: number;
  scoreBoost: number;
  finalScore: number;
  dependencyExact: boolean;
  checkedExact: boolean;
  pathNeighborScore: number;
  selected: boolean;
};

export type DaemonPlaygroundFileDebug = {
  file: string;
  fileSummary: string;
  selectedDaemons: string[];
  scores: DaemonPlaygroundFileScore[];
  mode: string;
  librarianRationale?: string;
  librarianConfidence?: number;
};

export type DaemonPlaygroundScenarioResult = {
  scenario: string;
  files: string[];
  expectedByFile: Record<string, string[]>;
  evaluation: {
    routedDaemons: Array<{ name: string; relevantFiles: string[] }>;
    fileDebug: DaemonPlaygroundFileDebug[];
  };
};

export type DaemonPlaygroundRunResult = {
  generatedAt: string;
  profiles: Array<{
    profile: DaemonPlaygroundProfile;
    scenarios: DaemonPlaygroundScenarioResult[];
  }>;
};

export async function fetchDaemonPlayground(
  profiles?: DaemonPlaygroundProfile[],
): Promise<DaemonPlaygroundRunResult> {
  return requestJson("/api/daemon-review/playground", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ profiles }),
  });
}
