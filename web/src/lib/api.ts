export type ChangeStatus =
  | "pushed"
  | "scoring"
  | "scored"
  | "summarizing"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "merging"
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
