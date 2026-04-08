import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WideCollectorEvent } from "../service/collector-contract";
import type {
	AcceptedCollectorBatch,
	RawEventStore,
} from "../service/collector-service";

function partitionDate(ts: string) {
	return ts.slice(0, 10);
}

function rawPath(rootDir: string, date: string, service: string) {
	return join(rootDir, `date=${date}`, `service=${service}`, "events.ndjson");
}

export class FileRawEventStore implements RawEventStore {
	private readonly rootDir: string;

	constructor(rootDir: string) {
		this.rootDir = resolve(rootDir);
	}

	appendBatch(batch: AcceptedCollectorBatch): void {
		const buffers = new Map<string, string[]>();

		for (const event of batch.events) {
			const filePath = rawPath(
				this.rootDir,
				partitionDate(event.ts),
				event.service,
			);
			const lines = buffers.get(filePath) ?? [];
			lines.push(`${JSON.stringify(event)}\n`);
			buffers.set(filePath, lines);
		}

		for (const [filePath, lines] of buffers.entries()) {
			mkdirSync(dirname(filePath), { recursive: true });
			appendFileSync(filePath, lines.join(""), "utf8");
		}
	}

	async listEventsSince(since: Date): Promise<WideCollectorEvent[]> {
		const events: WideCollectorEvent[] = [];
		const files = await collectFiles(this.rootDir);

		for (const filePath of files) {
			const text = await readFile(filePath, "utf8");
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

		return events;
	}
}

async function collectFiles(rootDir: string): Promise<string[]> {
	const entries = await readdir(rootDir, { withFileTypes: true }).catch(
		() => [],
	);
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(fullPath)));
			continue;
		}
		if (entry.isFile()) {
			files.push(fullPath);
		}
	}

	return files;
}
