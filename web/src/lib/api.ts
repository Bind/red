export type ChangeStatus =
  | "pushed"
  | "scoring"
  | "scored"
  | "summarizing"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "merging"
  | "merge_failed"
  | "merged"
  | "closed"
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
  pr_number: number | null;
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
  merged: number;
  pending_review: number;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function fetchVelocity(hours?: number): Promise<Velocity> {
  const params = hours ? `?hours=${hours}` : "";
  return apiFetch(`/api/velocity${params}`);
}

export function fetchReviewQueue(): Promise<Change[]> {
  return apiFetch("/api/review");
}

export function fetchChange(id: number): Promise<ChangeDetail> {
  return apiFetch(`/api/changes/${id}`);
}

export function fetchPendingJobs(): Promise<{ pending: number }> {
  return apiFetch("/api/jobs/pending");
}

export async function fetchDiff(id: number): Promise<string> {
  const res = await fetch(`/api/changes/${id}/diff`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.text();
}

export async function approveChange(id: number): Promise<void> {
  const res = await fetch(`/api/changes/${id}/approve`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
}

export async function regenerateSummary(id: number): Promise<void> {
  const res = await fetch(`/api/changes/${id}/regenerate-summary`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
}

export async function retryMerge(id: number): Promise<void> {
  const res = await fetch(`/api/changes/${id}/retry-merge`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
}

export function fetchRepos(): Promise<string[]> {
  return apiFetch("/api/repos");
}

export interface Branch {
  name: string;
  commit: { id: string; message: string; timestamp: string };
  change: { id: number; status: ChangeStatus; pr_number: number | null } | null;
  has_open_pr: boolean;
}

export function fetchBranches(repo: string): Promise<Branch[]> {
  return apiFetch(`/api/branches?repo=${encodeURIComponent(repo)}`);
}

export async function createPR(repo: string, branch: string, title: string, body?: string): Promise<{ number: number }> {
  const res = await fetch("/api/branches/create-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, branch, title, body }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(data.error ?? `API error: ${res.status}`);
  }
  return res.json();
}

export type CodexSessionStatus = "running" | "completed" | "failed";

export interface CodexSession {
  id: number;
  change_id: number;
  job_id: number | null;
  job_type: string;
  status: CodexSessionStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface CodexSessionLog {
  id: number;
  session_id: number;
  seq: number;
  line: string;
  created_at: string;
}

export function fetchSessions(changeId: number): Promise<CodexSession[]> {
  return apiFetch(`/api/changes/${changeId}/sessions`);
}

export function fetchSessionLogs(sessionId: number, afterSeq: number = 0): Promise<CodexSessionLog[]> {
  return apiFetch(`/api/sessions/${sessionId}/logs?after=${afterSeq}`);
}

/**
 * Subscribe to real-time Codex log lines via SSE.
 * Returns a cleanup function to close the connection.
 */
export function subscribeToLogs(
  changeId: number,
  onLine: (line: string) => void,
  onDone: (data?: string) => void,
): () => void {
  const es = new EventSource(`/api/changes/${changeId}/logs`);

  es.addEventListener("log", (e) => {
    onLine(e.data);
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
