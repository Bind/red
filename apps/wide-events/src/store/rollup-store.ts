import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WideRollupRecord } from "../service/collector-contract";
import type { RollupStore } from "../service/collector-service";

function rollupPath(rootDir: string, rolledUpAt: string) {
	const date = rolledUpAt.slice(0, 10);
	const hour = rolledUpAt.slice(11, 13);
	return join(rootDir, `date=${date}`, `hour=${hour}`, "rollups.ndjson");
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
}
