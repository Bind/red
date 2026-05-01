/**
 * DuckDB-backed query engine for wide-event rollups stored as NDJSON on
 * either a local filesystem or an S3-compatible bucket (MinIO).
 *
 * One long-lived in-process DuckDB. Every query re-scans the NDJSON —
 * DuckDB's columnar scan is fast enough that we don't maintain a cache
 * or materialised view. When data volume grows, the next step is a
 * nightly `COPY ... TO 'date=YYYY-MM-DD.parquet'` compaction and
 * pointing the same queries at the Parquet path.
 */

import {
	DuckDBInstance,
	type DuckDBConnection,
} from "@duckdb/node-api";
import type { WideRollupRecord } from "../service/collector-contract";
import type {
	RollupListOptions,
	RollupStore,
} from "../service/collector-service";
import type { S3StorageConfig } from "../util/s3";

export interface DuckDbQueryConfig {
	/** Where to read rollup NDJSON from. */
	source:
		| { kind: "file"; rootDir: string }
		| { kind: "s3"; s3: S3StorageConfig };
}

export type AggregateKey =
	| "entry_service"
	| "route"
	| "final_outcome"
	| "error_name";

export interface AggregateOptions {
	groupBy: AggregateKey;
	since?: Date;
	limit?: number;
}

export interface AggregateRow {
	key: string;
	count: number;
	error_count: number;
	avg_duration_ms: number;
	p95_duration_ms: number;
}

export class DuckDbRollupQuery implements RollupStore {
	private readonly config: DuckDbQueryConfig;
	private connection: DuckDBConnection | null = null;
	private readonly readyPromise: Promise<void>;

	constructor(config: DuckDbQueryConfig) {
		this.config = config;
		this.readyPromise = this.init();
	}

	private async init(): Promise<void> {
		const instance = await DuckDBInstance.create(":memory:");
		this.connection = await instance.connect();

		if (this.config.source.kind === "s3") {
			const s3 = this.config.source.s3;
			const url = new URL(s3.endpoint);
			await this.connection.run(`INSTALL httpfs`);
			await this.connection.run(`LOAD httpfs`);
			const stmts: string[] = [
				`SET s3_region='${escape(s3.region)}'`,
				`SET s3_access_key_id='${escape(s3.accessKeyId)}'`,
				`SET s3_secret_access_key='${escape(s3.secretAccessKey)}'`,
				`SET s3_endpoint='${escape(url.host)}'`,
				`SET s3_url_style='path'`,
				`SET s3_use_ssl=${url.protocol === "https:" ? "true" : "false"}`,
			];
			for (const stmt of stmts) await this.connection.run(stmt);
		}
	}

	/** The NDJSON glob this instance reads. */
	private rollupPath(): string {
		if (this.config.source.kind === "file") {
			return `${this.config.source.rootDir.replace(/\/$/, "")}/date=*/hour=*/rollups.ndjson`;
		}
		const { bucket, prefix } = this.config.source.s3;
		return `s3://${bucket}/${prefix.replace(/^\/+|\/+$/g, "")}/date=*/hour=*/*.ndjson`;
	}

	private async getConn(): Promise<DuckDBConnection> {
		await this.readyPromise;
		if (!this.connection) throw new Error("duckdb connection not ready");
		return this.connection;
	}

	/**
	 * RollupStore contract: append is delegated to the underlying writer
	 * store. DuckDB is read-only here.
	 */
	appendRollups(): void {
		throw new Error(
			"DuckDbRollupQuery is read-only; use FileRollupStore / MinioRollupStore for writes",
		);
	}

	async listRollups(
		options: RollupListOptions = {},
	): Promise<WideRollupRecord[]> {
		const conn = await this.getConn();
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.service) {
			where.push(`entry_service = ?`);
			params.push(options.service);
		}
		if (options.outcome) {
			where.push(`final_outcome = ?`);
			params.push(options.outcome);
		}
		if (options.since) {
			where.push(`rolled_up_at >= ?`);
			params.push(options.since.toISOString());
		}
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

		const sql = `
      SELECT ${rollupPayloadSql()} AS payload
      FROM read_ndjson_auto('${escape(this.rollupPath())}')
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY rolled_up_at DESC
      LIMIT ${limit}
    `;
		const prepared = await conn.prepare(sql);
		for (let i = 0; i < params.length; i += 1) {
			prepared.bindVarchar(i + 1, String(params[i]));
		}
		const reader = await prepared.runAndReadAll();
		const rows = (await reader.getRowObjectsJS()) as Array<{ payload: string }>;
		return rows.map((row) => parseRollupPayload(row.payload));
	}

	async getRollup(requestId: string): Promise<WideRollupRecord | null> {
		const conn = await this.getConn();
		const prepared = await conn.prepare(
			`SELECT ${rollupPayloadSql()} AS payload
         FROM read_ndjson_auto('${escape(this.rollupPath())}')
         WHERE request_id = ?
         ORDER BY rolled_up_at DESC
         LIMIT 1`,
		);
		prepared.bindVarchar(1, requestId);
		const reader = await prepared.runAndReadAll();
		const rows = (await reader.getRowObjectsJS()) as Array<{ payload: string }>;
		const first = rows[0];
		return first ? parseRollupPayload(first.payload) : null;
	}

	async aggregateRollups(options: AggregateOptions): Promise<AggregateRow[]> {
		const conn = await this.getConn();
		const keyExpr = aggregateKeyExpression(options.groupBy);
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.since) {
			where.push(`rolled_up_at >= ?`);
			params.push(options.since.toISOString());
		}
		const sql = `
      SELECT
        ${keyExpr} AS key,
        COUNT(*)::INTEGER AS count,
        SUM(CASE WHEN final_outcome = 'error' THEN 1 ELSE 0 END)::INTEGER AS error_count,
        AVG(total_duration_ms)::DOUBLE AS avg_duration_ms,
        QUANTILE_CONT(total_duration_ms, 0.95)::DOUBLE AS p95_duration_ms
      FROM read_ndjson_auto('${escape(this.rollupPath())}')
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY key
      ORDER BY count DESC
      LIMIT ${limit}
    `;
		const prepared = await conn.prepare(sql);
		for (let i = 0; i < params.length; i += 1) {
			prepared.bindVarchar(i + 1, String(params[i]));
		}
		const reader = await prepared.runAndReadAll();
		const rows = (await reader.getRowObjectsJS()) as Array<{
			key: unknown;
			count: unknown;
			error_count: unknown;
			avg_duration_ms: unknown;
			p95_duration_ms: unknown;
		}>;
		return rows.map((row) => ({
			key: String(row.key ?? "(none)"),
			count: Number(row.count ?? 0),
			error_count: Number(row.error_count ?? 0),
			avg_duration_ms: Number(row.avg_duration_ms ?? 0),
			p95_duration_ms: Number(row.p95_duration_ms ?? 0),
		}));
	}
}

function coerceBigInts(value: unknown): unknown {
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (Array.isArray(value)) {
		return value.map(coerceBigInts);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = coerceBigInts(v);
		}
		return out;
	}
	return value;
}

function parseRollupPayload(payload: string): WideRollupRecord {
	return coerceBigInts(JSON.parse(payload)) as WideRollupRecord;
}

function rollupPayloadSql(): string {
	return `to_json(struct_pack(
      request_id := request_id,
      first_ts := first_ts,
      last_ts := last_ts,
      total_duration_ms := total_duration_ms,
      entry_service := entry_service,
      services := services,
      route_names := route_names,
      has_terminal_event := has_terminal_event,
      request_state := request_state,
      final_outcome := final_outcome,
      final_status_code := final_status_code,
      event_count := event_count,
      error_count := error_count,
      primary_error := primary_error,
      request := request,
      service_map := service_map,
      events := events,
      rollup_reason := rollup_reason,
      rolled_up_at := rolled_up_at,
      rollup_version := rollup_version
    ))`;
}

function aggregateKeyExpression(key: AggregateKey): string {
	switch (key) {
		case "entry_service":
			return "entry_service";
		case "route":
			return "COALESCE(route_names[1], '(none)')";
		case "final_outcome":
			return "final_outcome";
		case "error_name":
			return "COALESCE(primary_error->>'name', '(none)')";
	}
}

function escape(value: string): string {
	return value.replace(/'/g, "''");
}
