import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WideRollupRecord } from "../service/collector-contract";
import type {
	RollupListOptions,
	RollupStore,
} from "../service/collector-service";

function rollupPath(rootDir: string, rolledUpAt: string) {
	const date = rolledUpAt.slice(0, 10);
	const hour = rolledUpAt.slice(11, 13);
	return join(rootDir, `date=${date}`, `hour=${hour}`, "rollups.ndjson");
}

function safeReaddir(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path);
}

function datePartitions(rootDir: string): string[] {
	return safeReaddir(rootDir)
		.filter((name) => name.startsWith("date="))
		.sort()
		.reverse();
}

function hourPartitions(datePath: string): string[] {
	return safeReaddir(datePath)
		.filter((name) => name.startsWith("hour="))
		.sort()
		.reverse();
}

function matchesFilters(
	record: WideRollupRecord,
	options: RollupListOptions,
): boolean {
	if (options.service) {
		if (record.entry_service !== options.service) return false;
	}
	if (options.outcome) {
		if (record.final_outcome !== options.outcome) return false;
	}
	if (options.since) {
		if (Date.parse(record.rolled_up_at) < options.since.getTime()) return false;
	}
	return true;
}

export class FileRollupStore implements RollupStore {
	private readonly rootDir: string;

	constructor(rootDir: string) {
		this.rootDir = resolve(rootDir);
	}

	appendRollups(records: WideRollupRecord[]): void {
		const buffers = new Map<string, string[]>();

		for (const record of records) {
			const filePath = rollupPath(this.rootDir, record.rolled_up_at);
			const lines = buffers.get(filePath) ?? [];
			lines.push(`${JSON.stringify(record)}\n`);
			buffers.set(filePath, lines);
		}

		for (const [filePath, lines] of buffers.entries()) {
			mkdirSync(dirname(filePath), { recursive: true });
			appendFileSync(filePath, lines.join(""), "utf8");
		}
	}

	async listRollups(
		options: RollupListOptions = {},
	): Promise<WideRollupRecord[]> {
		const limit = options.limit ?? 100;
		const collected: WideRollupRecord[] = [];

		outer: for (const dateDir of datePartitions(this.rootDir)) {
			if (options.since) {
				const date = dateDir.slice(5);
				const sinceDate = options.since.toISOString().slice(0, 10);
				if (date < sinceDate) break;
			}

			const datePath = join(this.rootDir, dateDir);
			for (const hourDir of hourPartitions(datePath)) {
				const filePath = join(datePath, hourDir, "rollups.ndjson");
				if (!existsSync(filePath)) continue;
				const text = readFileSync(filePath, "utf8");
				for (const line of text.split("\n").reverse()) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const record = JSON.parse(trimmed) as WideRollupRecord;
					if (!matchesFilters(record, options)) continue;
					collected.push(record);
					if (collected.length >= limit) break outer;
				}
			}
		}

		collected.sort((a, b) =>
			b.rolled_up_at.localeCompare(a.rolled_up_at),
		);
		return collected.slice(0, limit);
	}

	async getRollup(requestId: string): Promise<WideRollupRecord | null> {
		for (const dateDir of datePartitions(this.rootDir)) {
			const datePath = join(this.rootDir, dateDir);
			for (const hourDir of hourPartitions(datePath)) {
				const filePath = join(datePath, hourDir, "rollups.ndjson");
				if (!existsSync(filePath)) continue;
				const text = readFileSync(filePath, "utf8");
				for (const line of text.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const record = JSON.parse(trimmed) as WideRollupRecord;
					if (record.request_id === requestId) return record;
				}
			}
		}
		return null;
	}
}
