#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MinioRollupStore } from "../store/minio-store";
import type { S3StorageConfig } from "../util/s3";

interface SyncConfig extends S3StorageConfig {
	outputDir: string;
}

function required(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	return trimmed;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
	return {
		endpoint: required(env.WIDE_EVENTS_S3_ENDPOINT, "WIDE_EVENTS_S3_ENDPOINT"),
		region: env.WIDE_EVENTS_S3_REGION?.trim() || "us-east-1",
		accessKeyId: required(
			env.WIDE_EVENTS_S3_ACCESS_KEY_ID,
			"WIDE_EVENTS_S3_ACCESS_KEY_ID",
		),
		secretAccessKey: required(
			env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY,
			"WIDE_EVENTS_S3_SECRET_ACCESS_KEY",
		),
		bucket: env.WIDE_EVENTS_ROLLUP_BUCKET?.trim() || "wide-events-rollup",
		prefix: env.WIDE_EVENTS_ROLLUP_PREFIX?.trim() || "rollup",
		outputDir: resolve(
			env.WIDE_EVENTS_AGENT_ROLLUP_CACHE_DIR ??
				".wide-events-agent/materialized/rollups",
		),
	};
}

const config = loadConfig();
const store = new MinioRollupStore(config);
const keys = await store.listRollupKeys();

for (const key of keys) {
	const text = await store.readRollupObject(key);
	const outputPath = resolve(config.outputDir, key.replaceAll("/", "__"));
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, text, "utf8");
}

console.log(
	JSON.stringify({ synced: keys.length, outputDir: config.outputDir }, null, 2),
);
