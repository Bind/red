import type { WideRollupRecord } from "./collector-contract";

export interface TriageDispatcher {
	dispatch(rollup: WideRollupRecord): Promise<void>;
}

export const noopTriageDispatcher: TriageDispatcher = {
	async dispatch() {},
};

export interface TriageFilterOptions {
	minStatusCode: number;
}

export function shouldTriage(
	rollup: WideRollupRecord,
	options: TriageFilterOptions,
): boolean {
	if (rollup.final_outcome !== "error") return false;
	const status = rollup.final_status_code;
	if (status === null || status === undefined) return false;
	return status >= options.minStatusCode;
}

export interface TriageFingerprintInput {
	entry_service: string;
	error_name: string;
	error_message: string;
	route: string;
}

export function triageFingerprint(rollup: WideRollupRecord): string {
	const primary = (rollup.primary_error ?? {}) as Record<string, unknown>;
	const errorName = typeof primary.name === "string" ? primary.name : "";
	const errorMessageRaw =
		typeof primary.message === "string" ? primary.message : "";
	const errorMessage = normalizeMessage(errorMessageRaw);
	const route = rollup.route_names[0] ?? "";
	return [rollup.entry_service, errorName, errorMessage, route].join("|");
}

function normalizeMessage(message: string): string {
	return message
		.replace(/0x[0-9a-f]+/gi, "0x?")
		.replace(/\d+/g, "?")
		.replace(/[\t\n\r]+/g, " ")
		.trim()
		.slice(0, 200);
}

export interface DedupingDispatcherOptions {
	inner: TriageDispatcher;
	filter: TriageFilterOptions;
	dedupTtlMs: number;
	now?: () => number;
	maxEntries?: number;
}

export class DedupingTriageDispatcher implements TriageDispatcher {
	private readonly inner: TriageDispatcher;
	private readonly filter: TriageFilterOptions;
	private readonly dedupTtlMs: number;
	private readonly now: () => number;
	private readonly maxEntries: number;
	private readonly lastFired = new Map<string, number>();

	constructor(options: DedupingDispatcherOptions) {
		this.inner = options.inner;
		this.filter = options.filter;
		this.dedupTtlMs = options.dedupTtlMs;
		this.now = options.now ?? (() => Date.now());
		this.maxEntries = options.maxEntries ?? 1024;
	}

	async dispatch(rollup: WideRollupRecord): Promise<void> {
		if (!shouldTriage(rollup, this.filter)) return;

		const nowMs = this.now();
		const fingerprint = triageFingerprint(rollup);
		const previous = this.lastFired.get(fingerprint);
		if (previous !== undefined && nowMs - previous < this.dedupTtlMs) {
			return;
		}

		this.prune(nowMs);
		this.lastFired.set(fingerprint, nowMs);
		await this.inner.dispatch(rollup);
	}

	private prune(nowMs: number): void {
		for (const [fingerprint, firedAt] of this.lastFired.entries()) {
			if (nowMs - firedAt >= this.dedupTtlMs) {
				this.lastFired.delete(fingerprint);
			}
		}
		if (this.lastFired.size <= this.maxEntries) return;

		const entries = [...this.lastFired.entries()].sort(
			(left, right) => left[1] - right[1],
		);
		const dropCount = this.lastFired.size - this.maxEntries;
		for (let i = 0; i < dropCount; i += 1) {
			this.lastFired.delete(entries[i][0]);
		}
	}
}

export interface HttpTriageDispatcherOptions {
	endpointUrl: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	onError?: (error: unknown, rollup: WideRollupRecord) => void;
}

export class HttpTriageDispatcher implements TriageDispatcher {
	private readonly endpointUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly onError: (error: unknown, rollup: WideRollupRecord) => void;

	constructor(options: HttpTriageDispatcherOptions) {
		this.endpointUrl = options.endpointUrl;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.onError =
			options.onError ??
			((error, rollup) => {
				console.error(
					`triage dispatch failed for request ${rollup.request_id}:`,
					error,
				);
			});
	}

	async dispatch(rollup: WideRollupRecord): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(this.endpointUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ rollup }),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(
					`triage endpoint returned ${response.status} ${response.statusText}`,
				);
			}
		} catch (error) {
			this.onError(error, rollup);
		} finally {
			clearTimeout(timeout);
		}
	}
}
