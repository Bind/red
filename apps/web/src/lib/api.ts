import { hc } from "hono/client";
import type { AppType } from "../../../bff/src/app";

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

const client = hc<AppType>("/");

async function rpcJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json() as Promise<T>;
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

export function fetchRepos(): Promise<string[]> {
  return client.rpc.repos.$get().then(rpcJson);
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
