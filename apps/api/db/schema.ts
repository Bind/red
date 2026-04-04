import { Database } from "bun:sqlite";

/**
 * Initialize the SQLite database with WAL mode and create tables.
 * All tables include org_id for future multi-tenancy.
 */
export function initDatabase(dbPath: string = ".local/state/redc.db"): Database {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read/write
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  migrate(db);

  return db;
}

export function initInMemoryDatabase(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL DEFAULT 'default',
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      pr_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pushed',
      confidence TEXT,
      created_by TEXT NOT NULL DEFAULT 'human',
      summary TEXT,
      diff_stats TEXT,
      delivery_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_org_repo
    ON changes(org_id, repo)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_status
    ON changes(status)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_status_updated
    ON changes(status, updated_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_delivery_id
    ON changes(delivery_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_repo_branch
    ON changes(repo, branch)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (change_id) REFERENCES changes(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_change_events_change_id
    ON change_events(change_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at
    ON jobs(status, run_at)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      provider TEXT NOT NULL DEFAULT 'internal',
      provider_ref TEXT,
      merge_commit_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (change_id) REFERENCES changes(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_pull_requests_change_id
    ON pull_requests(change_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_status
    ON pull_requests(repo, status)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id INTEGER NOT NULL,
      job_id INTEGER,
      job_type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      runtime_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      FOREIGN KEY (change_id) REFERENCES changes(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_change_id
    ON agent_sessions(change_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_run_id
    ON agent_sessions(run_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT,
      role TEXT,
      text TEXT,
      delta TEXT,
      data_json TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_session_events_session_seq
    ON agent_session_events(session_id, seq)
  `);
}
