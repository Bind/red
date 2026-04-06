import { hc } from "hono/client";
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

export interface CreateRepoInput {
  owner: string;
  name: string;
  defaultBranch?: string;
  visibility?: RepoVisibility;
}

const client = hc<AppType>("/") as any;

async function rpcJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body || `API error: ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body || `API error: ${response.status}`, response.status);
  }
  const text = await response.text();
  const trimmed = text.trim();
  return (trimmed ? JSON.parse(trimmed) : null) as T;
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
