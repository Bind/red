#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface LocalAgentConfig {
	duckdb: {
		path: string;
	};
	s3: {
		endpoint: string;
		region: string;
		access_key_id: string;
		secret_access_key: string;
		raw_bucket: string;
		raw_prefix: string;
		rollup_bucket: string;
		rollup_prefix: string;
		use_ssl: boolean;
		url_style: "path";
	};
	cache: {
		dir: string;
		materialized_dir: string;
	};
	refresh: {
		rollup_scan_interval_seconds: number;
		incomplete_request_grace_seconds: number;
	};
}

function buildLocalAgentConfig(
	env: NodeJS.ProcessEnv = process.env,
): LocalAgentConfig {
	const root = resolve(env.WIDE_EVENTS_AGENT_HOME ?? ".wide-events-agent");
	return {
		duckdb: {
			path: resolve(root, "agent.duckdb"),
		},
		s3: {
			endpoint: env.WIDE_EVENTS_S3_ENDPOINT ?? "http://127.0.0.1:9000",
			region: env.WIDE_EVENTS_S3_REGION ?? "us-east-1",
			access_key_id: env.WIDE_EVENTS_S3_ACCESS_KEY_ID ?? "minioadmin",
			secret_access_key: env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY ?? "minioadmin",
			raw_bucket: env.WIDE_EVENTS_RAW_BUCKET ?? "wide-events-raw",
			raw_prefix: env.WIDE_EVENTS_RAW_PREFIX ?? "raw/",
			rollup_bucket: env.WIDE_EVENTS_ROLLUP_BUCKET ?? "wide-events-rollup",
			rollup_prefix: env.WIDE_EVENTS_ROLLUP_PREFIX ?? "rollup/",
			use_ssl: env.WIDE_EVENTS_S3_USE_SSL === "true",
			url_style: "path",
		},
		cache: {
			dir: resolve(root, "cache"),
			materialized_dir: resolve(root, "materialized"),
		},
		refresh: {
			rollup_scan_interval_seconds: Number.parseInt(
				env.WIDE_EVENTS_AGENT_SCAN_INTERVAL_SECONDS ?? "30",
				10,
			),
			incomplete_request_grace_seconds: Number.parseInt(
				env.WIDE_EVENTS_AGENT_INCOMPLETE_GRACE_SECONDS ?? "60",
				10,
			),
		},
	};
}

if (import.meta.main) {
	const config = buildLocalAgentConfig();
	const outputPath = resolve(
		process.env.WIDE_EVENTS_AGENT_CONFIG_PATH ??
			".wide-events-agent/config.json",
	);
	mkdirSync(dirname(outputPath), { recursive: true });
	mkdirSync(config.cache.dir, { recursive: true });
	mkdirSync(config.cache.materialized_dir, { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	console.log(outputPath);
}
