import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CollectorDependencies,
	InMemoryActiveRequestAggregator,
} from "../service/collector-service";
import { MinioRawEventStore, MinioRollupStore } from "../store/minio-store";
import { FileRawEventStore } from "../store/raw-event-store";
import { FileRollupStore } from "../store/rollup-store";
import type { S3StorageConfig } from "./s3";

type StorageBackend = "file" | "minio";

export interface WideEventsLabConfig {
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
}

function positiveInt(
	value: string | undefined,
	fallback: number,
	label: string,
) {
	const parsed = Number.parseInt(value ?? `${fallback}`, 10);
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
	defaultBucket: string,
	defaultPrefix: string,
): S3StorageConfig {
	return {
		endpoint: requiredString(
			env.WIDE_EVENTS_S3_ENDPOINT,
			"WIDE_EVENTS_S3_ENDPOINT",
		),
		region: env.WIDE_EVENTS_S3_REGION?.trim() || "us-east-1",
		accessKeyId: requiredString(
			env.WIDE_EVENTS_S3_ACCESS_KEY_ID,
			"WIDE_EVENTS_S3_ACCESS_KEY_ID",
		),
		secretAccessKey: requiredString(
			env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY,
			"WIDE_EVENTS_S3_SECRET_ACCESS_KEY",
		),
		bucket: env[`WIDE_EVENTS_${prefix}_BUCKET`]?.trim() || defaultBucket,
		prefix: env[`WIDE_EVENTS_${prefix}_PREFIX`]?.trim() || defaultPrefix,
	};
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
): WideEventsLabConfig {
	const hostname = env.WIDE_EVENTS_LAB_HOST?.trim() || "127.0.0.1";
	const port = positiveInt(
		env.WIDE_EVENTS_LAB_PORT,
		4090,
		"WIDE_EVENTS_LAB_PORT",
	);
	const dataDir = resolve(
		env.WIDE_EVENTS_LAB_DATA_DIR ?? join(process.cwd(), ".wide-events-lab"),
	);
	const rawEventsDir = resolve(
		env.WIDE_EVENTS_LAB_RAW_EVENTS_DIR ?? join(dataDir, "raw"),
	);
	const rollupDir = resolve(
		env.WIDE_EVENTS_LAB_ROLLUP_DIR ?? join(dataDir, "rollup"),
	);
	const sweepIntervalMs = positiveInt(
		env.WIDE_EVENTS_LAB_SWEEP_INTERVAL_MS,
		5000,
		"WIDE_EVENTS_LAB_SWEEP_INTERVAL_MS",
	);
	const incompleteGraceMs = positiveInt(
		env.WIDE_EVENTS_LAB_INCOMPLETE_GRACE_MS,
		60000,
		"WIDE_EVENTS_LAB_INCOMPLETE_GRACE_MS",
	);
	const replayWindowMs = positiveInt(
		env.WIDE_EVENTS_LAB_REPLAY_WINDOW_MS,
		600000,
		"WIDE_EVENTS_LAB_REPLAY_WINDOW_MS",
	);
	const storageBackend =
		env.WIDE_EVENTS_STORAGE_BACKEND === "minio" ? "minio" : "file";

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
				? loadS3Config(env, "RAW", "wide-events-raw", "raw")
				: undefined,
		rollupS3:
			storageBackend === "minio"
				? loadS3Config(env, "ROLLUP", "wide-events-rollup", "rollup")
				: undefined,
	};
}

export function createStores(
	config: WideEventsLabConfig,
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
	config: WideEventsLabConfig,
): CollectorDependencies {
	const stores = createStores(config);
	return {
		...stores,
		activeRequests: new InMemoryActiveRequestAggregator({
			incompleteGraceMs: config.incompleteGraceMs,
		}),
	};
}
