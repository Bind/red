/**
 * HTTP client for a long-running Smithers multi-workflow server
 * (https://smithers.sh/integrations/server). Replaces the per-run
 * subprocess runner: one connection, many triage runs.
 */

import { Database } from "bun:sqlite";
import type { TriagePlan, TriageProposal } from "../types";
import { TriagePlanSchema, TriageProposalSchema } from "../types";

export type SmithersRunStatus =
	| "running"
	| "waiting-approval"
	| "finished"
	| "failed"
	| "cancelled";

export interface SmithersRunSummary {
	runId: string;
	workflowName: string;
	status: SmithersRunStatus;
	startedAtMs: number | null;
	finishedAtMs: number | null;
	summary: Record<string, number>;
}

export interface SmithersEvent {
	type: string;
	runId: string;
	nodeId?: string;
	iteration?: number;
	attempt?: number;
	timestampMs?: number;
	[key: string]: unknown;
}

export interface SmithersHttpClientOptions {
	baseUrl: string;
	authToken?: string;
	smithersDbPath: string;
	fetchImpl?: typeof fetch;
}

export class SmithersHttpClient {
	private readonly baseUrl: string;
	private readonly authToken?: string;
	private readonly dbPath: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: SmithersHttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.authToken = options.authToken;
		this.dbPath = options.smithersDbPath;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async startRun(input: {
		workflowPath: string;
		input: unknown;
		runId?: string;
	}): Promise<{ runId: string }> {
		const res = await this.request("POST", "/v1/runs", input);
		return (await res.json()) as { runId: string };
	}

	async getRun(runId: string): Promise<SmithersRunSummary> {
		const res = await this.request("GET", `/v1/runs/${runId}`);
		return (await res.json()) as SmithersRunSummary;
	}

	async approve(
		runId: string,
		nodeId: string,
		body: { note?: string; decidedBy?: string; iteration?: number } = {},
	): Promise<void> {
		await this.request(
			"POST",
			`/v1/runs/${runId}/nodes/${nodeId}/approve`,
			body,
		);
	}

	async deny(
		runId: string,
		nodeId: string,
		body: { note?: string; decidedBy?: string; iteration?: number } = {},
	): Promise<void> {
		await this.request(
			"POST",
			`/v1/runs/${runId}/nodes/${nodeId}/deny`,
			body,
		);
	}

	async cancel(runId: string): Promise<void> {
		await this.request("POST", `/v1/runs/${runId}/cancel`);
	}

	async *events(
		runId: string,
		options: { afterSeq?: number; signal?: AbortSignal } = {},
	): AsyncGenerator<SmithersEvent> {
		const params = options.afterSeq !== undefined
			? `?afterSeq=${options.afterSeq}`
			: "";
		const res = await this.fetchImpl(
			`${this.baseUrl}/v1/runs/${runId}/events${params}`,
			{
				method: "GET",
				headers: this.headers({ accept: "text/event-stream" }),
				signal: options.signal,
			},
		);
		if (!res.ok || !res.body) {
			throw new Error(
				`smithers events stream failed: ${res.status} ${res.statusText}`,
			);
		}
		const reader = res.body
			.pipeThrough(new TextDecoderStream())
			.getReader();
		let buffer = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += value;
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const parsed = parseSseFrame(raw);
				if (parsed) yield parsed;
				boundary = buffer.indexOf("\n\n");
			}
		}
	}

	readTriagePlan(runId: string): TriagePlan {
		const row = this.readLatestRow(runId, "triage_plan", "draft");
		return TriagePlanSchema.parse(row);
	}

	readTriageProposal(runId: string): TriageProposal {
		const row = this.readLatestRow(runId, "triage_proposal", "implement");
		return TriageProposalSchema.parse(row);
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<Response> {
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: this.headers(
				body !== undefined ? { "content-type": "application/json" } : {},
			),
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`smithers ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`,
			);
		}
		return res;
	}

	private headers(extra: Record<string, string> = {}): HeadersInit {
		const headers: Record<string, string> = { ...extra };
		if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
		return headers;
	}

	private readLatestRow(
		runId: string,
		tableName: string,
		nodeId: string,
	): unknown {
		const db = new Database(this.dbPath, { readonly: true });
		try {
			const row = db
				.query(
					`SELECT data FROM ${tableName}
					 WHERE run_id = ? AND node_id = ?
					 ORDER BY iteration DESC, created_at DESC
					 LIMIT 1`,
				)
				.get(runId, nodeId) as { data: string } | null;
			if (!row) {
				throw new Error(
					`no row in ${tableName} for run ${runId} node ${nodeId}`,
				);
			}
			return JSON.parse(row.data);
		} finally {
			db.close();
		}
	}
}

function parseSseFrame(raw: string): SmithersEvent | null {
	let dataLine: string | null = null;
	for (const line of raw.split("\n")) {
		if (line.startsWith("data:")) dataLine = line.slice(5).trim();
	}
	if (!dataLine) return null;
	try {
		return JSON.parse(dataLine) as SmithersEvent;
	} catch {
		return null;
	}
}
