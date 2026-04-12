import { Database } from "bun:sqlite";
import type { ClawRunRecord, ClawRunTracker } from "./types";

type ClawRunRow = {
  run_id: string;
  job_name: string;
  job_id: string | null;
  change_id: number | null;
  worker_id: string | null;
  repo: string;
  head_ref: string;
  base_ref: string | null;
  image: string;
  container_name: string;
  container_id: string | null;
  codex_session_id: string | null;
  rollout_path: string | null;
  status: ClawRunRecord["status"];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_type: string | null;
  error_message: string | null;
};

export class SqliteClawRunTracker implements ClawRunTracker {
  private db: Database;

  constructor(dbPath: string = process.env.CLAW_RUNS_DB_PATH ?? process.env.CODEX_RUNS_DB_PATH ?? ".claw-runs.db") {
    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.init();
  }

  create(record: ClawRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO codex_runs (
          run_id, job_name, job_id, change_id, worker_id, repo, head_ref, base_ref,
          image, container_name, container_id, codex_session_id, rollout_path, status, created_at, started_at, finished_at,
          duration_ms, error_type, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.jobName,
        record.jobId,
        record.changeId,
        record.workerId,
        record.repo,
        record.headRef,
        record.baseRef,
        record.image,
        record.containerName,
        record.containerId,
        record.codexSessionId,
        record.rolloutPath,
        record.status,
        record.createdAt,
        record.startedAt,
        record.finishedAt,
        record.durationMs,
        record.errorType,
        record.errorMessage
      );
  }

  markRunning(runId: string, containerId: string | null, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE codex_runs
         SET status = 'running', container_id = ?, started_at = ?
         WHERE run_id = ?`
      )
      .run(containerId, startedAt, runId);
  }

  attachRollout(runId: string, codexSessionId: string | null, rolloutPath: string | null): void {
    this.db
      .prepare(
        `UPDATE codex_runs
         SET codex_session_id = ?, rollout_path = ?
         WHERE run_id = ?`
      )
      .run(codexSessionId, rolloutPath, runId);
  }

  finish(
    runId: string,
    params: {
      status: "completed" | "failed";
      finishedAt: string;
      durationMs: number;
      errorType?: string | null;
      errorMessage?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE codex_runs
         SET status = ?, finished_at = ?, duration_ms = ?, error_type = ?, error_message = ?
         WHERE run_id = ?`
      )
      .run(
        params.status,
        params.finishedAt,
        params.durationMs,
        params.errorType ?? null,
        params.errorMessage ?? null,
        runId
      );
  }

  getByRunId(runId: string): ClawRunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM codex_runs WHERE run_id = ?")
      .get(runId) as ClawRunRow | null;
    return row ? mapRow(row) : null;
  }

  listRecent(limit: number = 20): ClawRunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM codex_runs ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as ClawRunRow[];
    return rows.map(mapRow);
  }

  listByStatus(status: ClawRunRecord["status"], limit: number = 100): ClawRunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM codex_runs WHERE status = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(status, limit) as ClawRunRow[];
    return rows.map(mapRow);
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS codex_runs (
        run_id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        job_id TEXT,
        change_id INTEGER,
        worker_id TEXT,
        repo TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        base_ref TEXT,
        image TEXT NOT NULL,
        container_name TEXT NOT NULL,
        container_id TEXT,
        codex_session_id TEXT,
        rollout_path TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        error_type TEXT,
        error_message TEXT
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_codex_runs_created_at
      ON codex_runs(created_at)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_codex_runs_job_name
      ON codex_runs(job_name)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_codex_runs_status
      ON codex_runs(status)
    `);

    try {
      this.db.run("ALTER TABLE codex_runs ADD COLUMN codex_session_id TEXT");
    } catch {}

    try {
      this.db.run("ALTER TABLE codex_runs ADD COLUMN rollout_path TEXT");
    } catch {}
  }
}

function mapRow(row: ClawRunRow): ClawRunRecord {
  return {
    runId: row.run_id,
    jobName: row.job_name,
    jobId: row.job_id,
    changeId: row.change_id,
    workerId: row.worker_id,
    repo: row.repo,
    headRef: row.head_ref,
    baseRef: row.base_ref,
    image: row.image,
    containerName: row.container_name,
    containerId: row.container_id,
    codexSessionId: row.codex_session_id,
    rolloutPath: row.rollout_path,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorType: row.error_type,
    errorMessage: row.error_message,
  };
}
