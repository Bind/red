import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  Change,
  ChangeEvent,
  ChangeStatus,
  ConfidenceLevel,
  CreatedBy,
  Job,
} from "../types";

export class ChangeQueries {
  constructor(private db: Database) {}

  create(params: {
    org_id: string;
    repo: string;
    branch: string;
    base_branch: string;
    head_sha: string;
    pr_number?: number | null;
    created_by: CreatedBy;
    delivery_id: string;
    diff_stats?: string | null;
  }): Change {
    const stmt = this.db.prepare(`
      INSERT INTO changes (org_id, repo, branch, base_branch, head_sha, pr_number, created_by, delivery_id, diff_stats)
      VALUES ($org_id, $repo, $branch, $base_branch, $head_sha, $pr_number, $created_by, $delivery_id, $diff_stats)
    `);
    stmt.run({
      $org_id: params.org_id,
      $repo: params.repo,
      $branch: params.branch,
      $base_branch: params.base_branch,
      $head_sha: params.head_sha,
      $pr_number: params.pr_number ?? null,
      $created_by: params.created_by,
      $delivery_id: params.delivery_id,
      $diff_stats: params.diff_stats ?? null,
    });
    const id = this.db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    return this.getById(id.id)!;
  }

  getById(id: number): Change | null {
    return this.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as
      | Change
      | null;
  }

  getByDeliveryId(deliveryId: string): Change | null {
    return this.db
      .prepare("SELECT * FROM changes WHERE delivery_id = ?")
      .get(deliveryId) as Change | null;
  }

  updateStatus(id: number, status: ChangeStatus): void {
    this.db
      .prepare(
        "UPDATE changes SET status = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(status, id);
  }

  updateConfidence(id: number, confidence: ConfidenceLevel): void {
    this.db
      .prepare(
        "UPDATE changes SET confidence = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(confidence, id);
  }

  updateSummary(id: number, summary: string): void {
    this.db
      .prepare(
        "UPDATE changes SET summary = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(summary, id);
  }

  updateDiffStats(id: number, diffStats: string): void {
    this.db
      .prepare(
        "UPDATE changes SET diff_stats = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(diffStats, id);
  }

  updatePrNumber(id: number, prNumber: number): void {
    this.db
      .prepare(
        "UPDATE changes SET pr_number = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(prNumber, id);
  }

  /** Mark all open changes on a repo+branch as superseded (new push arrived). */
  supersedePrior(repo: string, branch: string, excludeId: number): number {
    const result = this.db
      .prepare(
        `UPDATE changes SET status = 'superseded', updated_at = datetime('now')
       WHERE repo = ? AND branch = ? AND id != ?
       AND status NOT IN ('merged', 'closed', 'superseded')`
      )
      .run(repo, branch, excludeId);
    return result.changes;
  }

  listByStatus(
    status: ChangeStatus,
    opts?: { org_id?: string; limit?: number; offset?: number }
  ): Change[] {
    let query = "SELECT * FROM changes WHERE status = ?";
    const params: SQLQueryBindings[] = [status];
    if (opts?.org_id) {
      query += " AND org_id = ?";
      params.push(opts.org_id);
    }
    query += " ORDER BY updated_at DESC";
    if (opts?.limit) {
      query += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset) {
      query += " OFFSET ?";
      params.push(opts.offset);
    }
    return this.db.prepare(query).all(...params) as Change[];
  }

  listForReview(org_id?: string): Change[] {
    let query = `
      SELECT * FROM changes
      WHERE status IN ('ready_for_review', 'scored')
    `;
    const params: SQLQueryBindings[] = [];
    if (org_id) {
      query += " AND org_id = ?";
      params.push(org_id);
    }
    query += " ORDER BY CASE confidence WHEN 'critical' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'safe' THEN 2 ELSE 3 END, updated_at ASC";
    return this.db.prepare(query).all(...params) as Change[];
  }

  /** List distinct repos that have changes. */
  listRepos(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT repo FROM changes ORDER BY repo"
    ).all() as { repo: string }[];
    return rows.map((r) => r.repo);
  }

  /** Get the latest active (non-terminal) change for a repo+branch. */
  getActiveByRepoBranch(repo: string, branch: string): Change | null {
    return this.db.prepare(
      `SELECT * FROM changes WHERE repo = ? AND branch = ?
       AND status NOT IN ('merged', 'closed', 'superseded')
       ORDER BY created_at DESC LIMIT 1`
    ).get(repo, branch) as Change | null;
  }

  /** Merge velocity: count of changes merged in the last N hours. */
  mergeVelocity(hours: number = 24, org_id?: string): { merged: number; pending_review: number } {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    let mergedQuery = "SELECT COUNT(*) as count FROM changes WHERE status = 'merged' AND updated_at >= ?";
    let pendingQuery = "SELECT COUNT(*) as count FROM changes WHERE status IN ('ready_for_review', 'scored') ";
    const mergedParams: SQLQueryBindings[] = [since];
    const pendingParams: SQLQueryBindings[] = [];

    if (org_id) {
      mergedQuery += " AND org_id = ?";
      mergedParams.push(org_id);
      pendingQuery += " AND org_id = ?";
      pendingParams.push(org_id);
    }

    const merged = this.db.prepare(mergedQuery).get(...mergedParams) as { count: number };
    const pending = this.db.prepare(pendingQuery).get(...pendingParams) as { count: number };

    return { merged: merged.count, pending_review: pending.count };
  }
}

export class EventQueries {
  constructor(private db: Database) {}

  append(params: {
    change_id: number;
    event_type: string;
    from_status?: ChangeStatus | null;
    to_status?: ChangeStatus | null;
    metadata?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO change_events (change_id, event_type, from_status, to_status, metadata)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.change_id,
        params.event_type,
        params.from_status ?? null,
        params.to_status ?? null,
        params.metadata ?? null
      );
  }

  listByChangeId(changeId: number): ChangeEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM change_events WHERE change_id = ? ORDER BY created_at ASC"
      )
      .all(changeId) as ChangeEvent[];
  }
}

export class JobQueries {
  constructor(private db: Database) {}

  enqueue(params: {
    org_id: string;
    type: string;
    payload: string;
    max_attempts?: number;
  }): Job {
    this.db
      .prepare(
        `INSERT INTO jobs (org_id, type, payload, max_attempts)
       VALUES (?, ?, ?, ?)`
      )
      .run(
        params.org_id,
        params.type,
        params.payload,
        params.max_attempts ?? 3
      );
    const id = this.db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id.id) as Job;
  }

  /** Claim the next pending job that's ready to run. */
  claimNext(type?: string): Job | null {
    let query = `
      UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending' AND run_at <= datetime('now')
    `;
    const params: SQLQueryBindings[] = [];
    if (type) {
      query += " AND type = ?";
      params.push(type);
    }
    query += " ORDER BY run_at ASC LIMIT 1) RETURNING *";
    return this.db.prepare(query).get(...params) as Job | null;
  }

  complete(id: number): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }

  fail(id: number, error: string): void {
    const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job;
    if (job && job.attempts >= job.max_attempts) {
      this.db
        .prepare(
          "UPDATE jobs SET status = 'dead', last_error = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(error, id);
    } else {
      // Exponential backoff: 2^attempts minutes
      const backoffMinutes = Math.pow(2, job?.attempts ?? 1);
      this.db
        .prepare(
          `UPDATE jobs SET status = 'pending', last_error = ?,
           run_at = datetime('now', '+${backoffMinutes} minutes'),
           updated_at = datetime('now') WHERE id = ?`
        )
        .run(error, id);
    }
  }

  pendingCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'pending'")
        .get() as { count: number }
    ).count;
  }
}

export class DeliveryQueries {
  constructor(private db: Database) {}

  /** Returns true if this delivery was already processed. */
  isDuplicate(deliveryId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM webhook_deliveries WHERE id = ?")
      .get(deliveryId);
    return row !== null;
  }

  record(deliveryId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO webhook_deliveries (id) VALUES (?)")
      .run(deliveryId);
  }
}
