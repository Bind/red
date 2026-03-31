/**
 * Core domain types for redc.
 *
 * Change lifecycle state machine:
 *
 *   pushed → scoring → scored → summarizing → ready_for_review
 *                                                 ↓           ↓
 *                                             approved    rejected
 *                                                 ↓
 *                                             merging → merged
 *                                                 ↓
 *                                              closed
 *
 *   Any state → superseded (new push to same branch)
 */

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
  delivery_id: string;
  created_at: string;
  updated_at: string;
}

export interface DiffStats {
  files_changed: number;
  additions: number;
  deletions: number;
  files: FileStats[];
}

export interface FileStats {
  filename: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
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

export interface Job {
  id: number;
  org_id: string;
  type: string;
  payload: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: string;
  created_at: string;
  updated_at: string;
}

export interface PolicyRule {
  name: string;
  match: {
    files?: string[];
    confidence?: ConfidenceLevel;
  };
  action: "auto-approve" | "require-review" | "block";
  reviewers?: string[];
}

export interface PolicyConfig {
  rules: PolicyRule[];
}

export interface SummaryAnnotation {
  text: string;
  files: string[];
  type: "new_module" | "refactor" | "bugfix" | "config" | "change";
}

export interface LLMSummary {
  title: string;
  what_changed: string;
  risk_assessment: string;
  affected_modules: string[];
  recommended_action: "approve" | "review" | "block";
  annotations?: SummaryAnnotation[];
}

/** Forgejo webhook push payload (relevant fields). */
export interface ForgejoPushPayload {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: ForgejoCommit[];
  repository: ForgejoRepository;
  sender: ForgejoUser;
}

export interface ForgejoCommit {
  id: string;
  message: string;
  author: { name: string; email: string };
  timestamp: string;
}

export interface ForgejoRepository {
  id: number;
  name: string;
  full_name: string;
  owner: ForgejoUser;
  default_branch: string;
}

export interface ForgejoUser {
  id: number;
  login: string;
}

/** Forgejo commit status. */
export type CommitStatusState = "pending" | "success" | "failure" | "error";

export interface ForgejoCommitStatus {
  state: CommitStatusState;
  target_url?: string;
  description: string;
  context: string;
}

/** Forgejo PR (relevant fields). */
export interface ForgejoPR {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

/** Notification webhook config. */
export interface NotificationConfig {
  url: string;
  events: ("critical" | "needs_review" | "all")[];
}

/** Forgejo admin API types for bootstrap. */
export interface ForgejoCreateUserOptions {
  username: string;
  password: string;
  email: string;
  must_change_password?: boolean;
}

export interface ForgejoSSHKey {
  id: number;
  key: string;
  title: string;
  fingerprint: string;
}

export interface ForgejoRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
}

export interface ForgejoToken {
  id: number;
  name: string;
  sha1: string;
}
