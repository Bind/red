import { Database } from "bun:sqlite";
import type { CanaryEvent, MirrorStateStore, RepoStatusRecord } from "../util/types";

function parseJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
}

export class SqliteMirrorStateStore implements MirrorStateStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_status (
        repo_id TEXT PRIMARY KEY,
        tracked_ref TEXT NOT NULL,
        last_run_status TEXT NOT NULL,
        last_source_head TEXT,
        last_target_head TEXT,
        last_run_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS canary_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_canary_events_repo_time
      ON canary_events(repo_id, occurred_at DESC);
    `);
  }

  getRepoStatus(repoId: string): RepoStatusRecord | null {
    const row = this.db
      .query(
        `SELECT
          repo_id,
          tracked_ref,
          last_run_status,
          last_source_head,
          last_target_head,
          last_run_at,
          last_success_at,
          last_error,
          consecutive_failures
        FROM repo_status
        WHERE repo_id = ?`,
      )
      .get(repoId) as Record<string, string | number | null> | null;

    if (!row) return null;
    return {
      repoId: `${row.repo_id ?? ""}`,
      trackedRef: `${row.tracked_ref ?? ""}`,
      lastRunStatus: `${row.last_run_status ?? "idle"}` as RepoStatusRecord["lastRunStatus"],
      lastSourceHead: row.last_source_head ? `${row.last_source_head}` : undefined,
      lastTargetHead: row.last_target_head ? `${row.last_target_head}` : undefined,
      lastRunAt: row.last_run_at ? `${row.last_run_at}` : undefined,
      lastSuccessAt: row.last_success_at ? `${row.last_success_at}` : undefined,
      lastError: row.last_error ? `${row.last_error}` : undefined,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    };
  }

  upsertRepoStatus(record: RepoStatusRecord) {
    this.db
      .query(
        `INSERT INTO repo_status (
          repo_id,
          tracked_ref,
          last_run_status,
          last_source_head,
          last_target_head,
          last_run_at,
          last_success_at,
          last_error,
          consecutive_failures
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id) DO UPDATE SET
          tracked_ref = excluded.tracked_ref,
          last_run_status = excluded.last_run_status,
          last_source_head = excluded.last_source_head,
          last_target_head = excluded.last_target_head,
          last_run_at = excluded.last_run_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          consecutive_failures = excluded.consecutive_failures`,
      )
      .run(
        record.repoId,
        record.trackedRef,
        record.lastRunStatus,
        record.lastSourceHead ?? null,
        record.lastTargetHead ?? null,
        record.lastRunAt ?? null,
        record.lastSuccessAt ?? null,
        record.lastError ?? null,
        record.consecutiveFailures,
      );
  }

  appendEvent(event: CanaryEvent) {
    this.db
      .query(
        `INSERT INTO canary_events (
          id,
          repo_id,
          type,
          severity,
          occurred_at,
          message,
          details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.repoId,
        event.type,
        event.severity,
        event.occurredAt,
        event.message,
        event.details ? JSON.stringify(event.details) : null,
      );
  }

  listRepoStatuses(): RepoStatusRecord[] {
    const rows = this.db
      .query(
        `SELECT
          repo_id,
          tracked_ref,
          last_run_status,
          last_source_head,
          last_target_head,
          last_run_at,
          last_success_at,
          last_error,
          consecutive_failures
        FROM repo_status
        ORDER BY repo_id ASC`,
      )
      .all() as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      repoId: `${row.repo_id ?? ""}`,
      trackedRef: `${row.tracked_ref ?? ""}`,
      lastRunStatus: `${row.last_run_status ?? "idle"}` as RepoStatusRecord["lastRunStatus"],
      lastSourceHead: row.last_source_head ? `${row.last_source_head}` : undefined,
      lastTargetHead: row.last_target_head ? `${row.last_target_head}` : undefined,
      lastRunAt: row.last_run_at ? `${row.last_run_at}` : undefined,
      lastSuccessAt: row.last_success_at ? `${row.last_success_at}` : undefined,
      lastError: row.last_error ? `${row.last_error}` : undefined,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    }));
  }

  listEvents(limit: number): CanaryEvent[] {
    const rows = this.db
      .query(
        `SELECT id, repo_id, type, severity, occurred_at, message, details_json
        FROM canary_events
        ORDER BY occurred_at DESC
        LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string | null>>;

    return rows.map((row) => ({
      id: `${row.id ?? ""}`,
      repoId: `${row.repo_id ?? ""}`,
      type: `${row.type ?? "mirror_issue"}` as CanaryEvent["type"],
      severity: `${row.severity ?? "error"}` as CanaryEvent["severity"],
      occurredAt: `${row.occurred_at ?? ""}`,
      message: `${row.message ?? ""}`,
      details: parseJson(row.details_json ?? null),
    }));
  }
}
