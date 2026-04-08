import { randomUUID } from "node:crypto";
import type { S3Client } from "bun";
import type {
	WideCollectorEvent,
	WideRollupRecord,
} from "../service/collector-contract";
import type {
	AcceptedCollectorBatch,
	RawEventStore,
	RollupStore,
} from "../service/collector-service";
import {
	createS3Client,
	datePartitionsBetween,
	joinKey,
	type S3StorageConfig,
} from "../util/s3";

function objectSuffix(): string {
	return `${Date.now()}-${randomUUID()}.ndjson`;
}

function rawKey(prefix: string, event: WideCollectorEvent): string {
	return joinKey(
		prefix,
		`date=${event.ts.slice(0, 10)}`,
		`service=${event.service}`,
		objectSuffix(),
	);
}

function rollupKey(prefix: string, record: WideRollupRecord): string {
	return joinKey(
		prefix,
		`date=${record.rolled_up_at.slice(0, 10)}`,
		`hour=${record.rolled_up_at.slice(11, 13)}`,
		objectSuffix(),
	);
}

async function listAllKeys(
	client: S3Client,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;

	do {
		const response = await client.list({
			prefix,
			continuationToken,
			maxKeys: 1000,
		});
		for (const entry of response.contents ?? []) {
			keys.push(entry.key);
		}
		continuationToken = response.nextContinuationToken;
	} while (continuationToken);

	return keys;
}

export class MinioRawEventStore implements RawEventStore {
	private readonly client: S3Client;
	private readonly prefix: string;

	constructor(config: S3StorageConfig) {
		this.client = createS3Client(config);
		this.prefix = config.prefix;
	}

	async appendBatch(batch: AcceptedCollectorBatch): Promise<void> {
		await Promise.all(
			batch.events.map((event) =>
				this.client.write(
					rawKey(this.prefix, event),
					`${JSON.stringify(event)}\n`,
					{
						type: "application/x-ndjson",
					},
				),
			),
		);
	}

	async listEventsSince(
		since: Date,
		now: Date = new Date(),
	): Promise<WideCollectorEvent[]> {
		const events: WideCollectorEvent[] = [];
		const prefixes = datePartitionsBetween(since, now).map((date) =>
			joinKey(this.prefix, `date=${date}`),
		);

		for (const prefix of prefixes) {
			const keys = await listAllKeys(this.client, prefix);
			for (const key of keys) {
				const text = await this.client.file(key).text();
				for (const line of text.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					const event = JSON.parse(trimmed) as WideCollectorEvent;
					if (Date.parse(event.ts) >= since.getTime()) {
						events.push(event);
					}
				}
			}
		}

		return events;
	}
}

export class MinioRollupStore implements RollupStore {
	private readonly client: S3Client;
	private readonly prefix: string;

	constructor(config: S3StorageConfig) {
		this.client = createS3Client(config);
		this.prefix = config.prefix;
	}

	async appendRollups(records: WideRollupRecord[]): Promise<void> {
		await Promise.all(
			records.map((record) =>
				this.client.write(
					rollupKey(this.prefix, record),
					`${JSON.stringify(record)}\n`,
					{
						type: "application/x-ndjson",
					},
				),
			),
		);
	}

	async listRollupKeys(prefixOverride?: string): Promise<string[]> {
		return listAllKeys(this.client, prefixOverride ?? this.prefix);
	}

	async readRollupObject(key: string): Promise<string> {
		return this.client.file(key).text();
	}
}
