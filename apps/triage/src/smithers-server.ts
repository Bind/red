#!/usr/bin/env bun
/**
 * Bootstraps a long-running Smithers HTTP server (multi-workflow mode).
 * The apps/triage service talks to this over HTTP/SSE to start triage
 * runs, stream events, and forward approvals.
 *
 * Env:
 *   SMITHERS_SERVER_PORT       default 7331
 *   SMITHERS_API_KEY           shared bearer token (required in prod)
 *   SMITHERS_DB_PATH           SQLite path for cross-run mirroring
 *   SMITHERS_ROOT_DIR          root for workflow path resolution
 *   SMITHERS_ALLOW_NETWORK     "true" to permit bash tool network access
 */

import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startServer } from "smithers-orchestrator";

const port = Number.parseInt(process.env.SMITHERS_SERVER_PORT ?? "7331", 10);
const authToken = process.env.SMITHERS_API_KEY;
const dbPath = resolve(
	process.env.SMITHERS_DB_PATH ?? "/smithers-data/smithers.db",
);
const rootDir = resolve(process.env.SMITHERS_ROOT_DIR ?? process.cwd());
const allowNetwork = process.env.SMITHERS_ALLOW_NETWORK?.toLowerCase() === "true";

mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

startServer({
	port,
	db,
	authToken,
	rootDir,
	allowNetwork,
});

console.log(`smithers server listening on :${port}`);
console.log(`  db:       ${dbPath}`);
console.log(`  rootDir:  ${rootDir}`);
console.log(`  auth:     ${authToken ? "enabled" : "disabled (no SMITHERS_API_KEY)"}`);
console.log(`  network:  ${allowNetwork ? "allowed" : "blocked"}`);
