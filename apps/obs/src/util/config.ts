import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CollectorDependencies,
	InMemoryActiveRequestAggregator,
	type RollupQuery,
} from "../service/collector-service";
import { createDaemonObservabilityQuery } from "../service/daemon-query";
import {
	DedupingTriageDispatcher,
	HttpTriageDispatcher,
	type TriageDispatcher,
} from "../service/triage-dispatcher";
import { RollupBroadcaster } from "../service/rollup-broadcaster";
import { DuckDbRollupQuery } from "../store/duckdb-query";
import { MinioRawEventStore, MinioRollupStore } from "../store/minio-store";
import { FileRawEventStore } from "../store/raw-event-store";
import { FileRollupStore } from "../store/rollup-store";
import type { S3StorageConfig } from "./s3";

type StorageBackend = "file" | "minio";

export interface TriageConfig {
	endpointUrl: string;
	minStatusCode: number;
	dedupTtlMs: number;
}

export interface WideEventsConfig {
	hostname: string;
	port: number;
	dataDir: string;
	rawEventsDir: string;
	rollupDir: string;
	sweepIntervalMs: number;
	incompleteGraceMs: number;
	replayWindowMs: number;
	storageBackend: StorageBackend;
	rawS3?: S3StorageConfig;
	rollupS3?: S3StorageConfig;
	triage?: TriageConfig;
}

function positiveInt(value: string | undefined, label: string) {
	const parsed = Number.parseInt(requiredString(value, label), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

function requiredString(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	return trimmed;
}

function loadS3Config(
	env: NodeJS.ProcessEnv,
	prefix: "RAW" | "ROLLUP",
): S3StorageConfig {
	return {
		endpoint: requiredString(
			env.WIDE_EVENTS_S3_ENDPOINT,
			"WIDE_EVENTS_S3_ENDPOINT",
		),
		region: requiredString(env.WIDE_EVENTS_S3_REGION, "WIDE_EVENTS_S3_REGION"),
		accessKeyId: requiredString(
			env.WIDE_EVENTS_S3_ACCESS_KEY_ID,
			"WIDE_EVENTS_S3_ACCESS_KEY_ID",
		),
		secretAccessKey: requiredString(
			env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY,
			"WIDE_EVENTS_S3_SECRET_ACCESS_KEY",
		),
		bucket: requiredString(
			env[`WIDE_EVENTS_${prefix}_BUCKET`],
			`WIDE_EVENTS_${prefix}_BUCKET`,
		),
		prefix: requiredString(
			env[`WIDE_EVENTS_${prefix}_PREFIX`],
			`WIDE_EVENTS_${prefix}_PREFIX`,
		),
	};
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
): WideEventsConfig {
	const hostname = requiredString(env.WIDE_EVENTS_HOST, "WIDE_EVENTS_HOST");
	const port = positiveInt(env.WIDE_EVENTS_PORT, "WIDE_EVENTS_PORT");
	const storageBackendValue = requiredString(
		env.WIDE_EVENTS_STORAGE_BACKEND,
		"WIDE_EVENTS_STORAGE_BACKEND",
	);
	if (storageBackendValue !== "file" && storageBackendValue !== "minio") {
		throw new Error(
			"WIDE_EVENTS_STORAGE_BACKEND must be either 'file' or 'minio'",
		);
	}
	const storageBackend = storageBackendValue as StorageBackend;
	const dataDir = resolve(
		requiredString(env.WIDE_EVENTS_DATA_DIR, "WIDE_EVENTS_DATA_DIR"),
	);
	const rawEventsDir = resolve(
		requiredString(
			env.WIDE_EVENTS_RAW_EVENTS_DIR,
			"WIDE_EVENTS_RAW_EVENTS_DIR",
		),
	);
	const rollupDir = resolve(
		requiredString(env.WIDE_EVENTS_ROLLUP_DIR, "WIDE_EVENTS_ROLLUP_DIR"),
	);
	const sweepIntervalMs = positiveInt(
		env.WIDE_EVENTS_SWEEP_INTERVAL_MS,
		"WIDE_EVENTS_SWEEP_INTERVAL_MS",
	);
	const incompleteGraceMs = positiveInt(
		env.WIDE_EVENTS_INCOMPLETE_GRACE_MS,
		"WIDE_EVENTS_INCOMPLETE_GRACE_MS",
	);
	const replayWindowMs = positiveInt(
		env.WIDE_EVENTS_REPLAY_WINDOW_MS,
		"WIDE_EVENTS_REPLAY_WINDOW_MS",
	);

	mkdirSync(rawEventsDir, { recursive: true });
	mkdirSync(rollupDir, { recursive: true });

	return {
		hostname,
		port,
		dataDir,
		rawEventsDir,
		rollupDir,
		sweepIntervalMs,
		incompleteGraceMs,
		replayWindowMs,
		storageBackend,
		rawS3:
			storageBackend === "minio"
				? loadS3Config(env, "RAW")
				: undefined,
		rollupS3:
			storageBackend === "minio"
				? loadS3Config(env, "ROLLUP")
				: undefined,
		triage: loadTriageConfig(env),
	};
}

function loadTriageConfig(
	env: NodeJS.ProcessEnv,
): TriageConfig | undefined {
	if (env.TRIAGE_ENABLED?.toLowerCase() !== "true") return undefined;
	const endpointUrl = env.TRIAGE_ENDPOINT_URL?.trim();
	if (!endpointUrl) return undefined;
	const minStatusCode = env.TRIAGE_MIN_STATUS_CODE
		? Number.parseInt(env.TRIAGE_MIN_STATUS_CODE, 10)
		: 500;
	if (!Number.isFinite(minStatusCode)) {
		throw new Error("TRIAGE_MIN_STATUS_CODE must be an integer");
	}
	const dedupTtlMs = env.TRIAGE_DEDUP_TTL_MS
		? Number.parseInt(env.TRIAGE_DEDUP_TTL_MS, 10)
		: 15 * 60_000;
	if (!Number.isFinite(dedupTtlMs) || dedupTtlMs <= 0) {
		throw new Error("TRIAGE_DEDUP_TTL_MS must be a positive integer");
	}
	return { endpointUrl, minStatusCode, dedupTtlMs };
}

function createTriageDispatcher(
	config: TriageConfig,
): TriageDispatcher {
	return new DedupingTriageDispatcher({
		inner: new HttpTriageDispatcher({ endpointUrl: config.endpointUrl }),
		filter: { minStatusCode: config.minStatusCode },
		dedupTtlMs: config.dedupTtlMs,
	});
}

export function createStores(
	config: WideEventsConfig,
): Pick<CollectorDependencies, "rawEventStore" | "rollupStore"> {
	if (config.storageBackend === "minio") {
		if (!config.rawS3 || !config.rollupS3) {
			throw new Error(
				"MinIO storage backend requires rawS3 and rollupS3 config",
			);
		}
		return {
			rawEventStore: new MinioRawEventStore(config.rawS3),
			rollupStore: new MinioRollupStore(config.rollupS3),
		};
	}

	return {
		rawEventStore: new FileRawEventStore(config.rawEventsDir),
		rollupStore: new FileRollupStore(config.rollupDir),
	};
}

export function createCollectorDeps(
	config: WideEventsConfig,
): CollectorDependencies {
	const stores = createStores(config);
	return {
		...stores,
		activeRequests: new InMemoryActiveRequestAggregator({
			incompleteGraceMs: config.incompleteGraceMs,
		}),
		rollupQuery: createRollupQuery(config),
		triageDispatcher: config.triage
			? createTriageDispatcher(config.triage)
			: undefined,
		daemonQuery: shouldEnableDaemonQuery() ? createDaemonObservabilityQuery() : undefined,
		rollupBroadcaster: new RollupBroadcaster(),
	};
}

function shouldEnableDaemonQuery(env: NodeJS.ProcessEnv = process.env): boolean {
	// Local mode (default backend) needs no config — always enable unless explicitly disabled.
	// Remote backends (r2) require explicit config.
	const backend = env.AI_DAEMONS_MEMORY_BACKEND ?? "local";
	if (backend === "local") return true;
	return Boolean(env.AI_DAEMONS_MEMORY_DIR || env.AI_DAEMONS_R2_BUCKET);
}

function createRollupQuery(config: WideEventsConfig): RollupQuery {
	if (config.storageBackend === "minio") {
		if (!config.rollupS3) {
			throw new Error("rollup query engine needs rollupS3 config in MinIO mode");
		}
		return new DuckDbRollupQuery({
			source: { kind: "s3", s3: config.rollupS3 },
		});
	}
	return new DuckDbRollupQuery({
		source: { kind: "file", rootDir: config.rollupDir },
	});
}
