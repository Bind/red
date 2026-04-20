import type { ObsFields } from "../util/types";
import { buildCanonicalRequest } from "./canonical-request";
import type {
	WideCollectorBatchRequest,
	WideCollectorBatchResponse,
	WideCollectorEvent,
	WideCollectorRejectedEvent,
	WideRollupRecord,
} from "./collector-contract";
import type { TriageDispatcher } from "./triage-dispatcher";

export interface AcceptedCollectorBatch {
	sent_at: string;
	source: WideCollectorBatchRequest["source"];
	events: WideCollectorEvent[];
}

export interface RawEventStore {
	appendBatch(batch: AcceptedCollectorBatch): Promise<void> | void;
	listEventsSince(since: Date, now?: Date): Promise<WideCollectorEvent[]>;
}

export interface RollupListOptions {
	since?: Date;
	service?: string;
	outcome?: "ok" | "error" | "unknown";
	limit?: number;
}

export interface RollupStore {
	appendRollups(records: WideRollupRecord[]): Promise<void> | void;
	listRollups?(options?: RollupListOptions): Promise<WideRollupRecord[]>;
	getRollup?(requestId: string): Promise<WideRollupRecord | null>;
}

export interface ActiveRequestAggregator {
	acceptBatch(
		batch: AcceptedCollectorBatch,
	): Promise<WideRollupRecord[]> | WideRollupRecord[];
	flushExpired(now?: Date): Promise<WideRollupRecord[]> | WideRollupRecord[];
}

export interface AggregateOptions {
	groupBy: "entry_service" | "route" | "final_outcome" | "error_name";
	since?: Date;
	limit?: number;
}

export interface AggregateRow {
	key: string;
	count: number;
	error_count: number;
	avg_duration_ms: number;
	p95_duration_ms: number;
}

export interface RollupQuery {
	listRollups(options?: RollupListOptions): Promise<WideRollupRecord[]>;
	getRollup(requestId: string): Promise<WideRollupRecord | null>;
	aggregateRollups?(options: AggregateOptions): Promise<AggregateRow[]>;
}

export interface CollectorDependencies {
	rawEventStore: RawEventStore;
	rollupStore: RollupStore;
	/** Optional — when set, GET /v1/rollups* uses this. Falls back to rollupStore. */
	rollupQuery?: RollupQuery;
	activeRequests: ActiveRequestAggregator;
	triageDispatcher?: TriageDispatcher;
}

interface EventValidationResult {
	event?: WideCollectorEvent;
	error?: WideCollectorRejectedEvent;
}

interface ActiveRequestState {
	events: WideCollectorEvent[];
	lastSeenAtMs: number;
}

export interface InMemoryActiveRequestAggregatorOptions {
	incompleteGraceMs: number;
	rollupVersion?: number;
	dedupTtlMs?: number;
	now?: () => Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function requiredString(
	value: unknown,
	field: string,
	eventId: string,
): { value?: string; error?: WideCollectorRejectedEvent } {
	const normalized = optionalString(value);
	if (!normalized) {
		return {
			error: {
				event_id: eventId,
				reason: `${field} is required`,
			},
		};
	}
	return { value: normalized };
}

function validateEvent(input: unknown, index: number): EventValidationResult {
	if (!isPlainObject(input)) {
		return {
			error: {
				event_id: `index:${index}`,
				reason: "event must be an object",
			},
		};
	}

	const eventId = optionalString(input.event_id) ?? `index:${index}`;
	const eventIdResult = requiredString(input.event_id, "event_id", eventId);
	if (eventIdResult.error) return { error: eventIdResult.error };
	const requestIdResult = requiredString(
		input.request_id,
		"request_id",
		eventId,
	);
	if (requestIdResult.error) return { error: requestIdResult.error };
	const serviceResult = requiredString(input.service, "service", eventId);
	if (serviceResult.error) return { error: serviceResult.error };
	const kindResult = requiredString(input.kind, "kind", eventId);
	if (kindResult.error) return { error: kindResult.error };
	const tsResult = requiredString(input.ts, "ts", eventId);
	if (tsResult.error) return { error: tsResult.error };

	if (!isPlainObject(input.data)) {
		return {
			error: {
				event_id: eventId,
				reason: "data must be an object",
			},
		};
	}

	if (Number.isNaN(Date.parse(tsResult.value ?? ""))) {
		return {
			error: {
				event_id: eventId,
				reason: "ts must be an ISO-8601 timestamp",
			},
		};
	}

	const endedAt = optionalString(input.ended_at);
	if (endedAt && Number.isNaN(Date.parse(endedAt))) {
		return {
			error: {
				event_id: eventId,
				reason: "ended_at must be an ISO-8601 timestamp when present",
			},
		};
	}

	const durationMs =
		typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms)
			? Math.trunc(input.duration_ms)
			: undefined;
	const statusCode =
		typeof input.status_code === "number" && Number.isFinite(input.status_code)
			? Math.trunc(input.status_code)
			: undefined;
	const outcome =
		input.outcome === "ok" || input.outcome === "error"
			? input.outcome
			: undefined;

	return {
		event: {
			event_id: eventIdResult.value ?? eventId,
			request_id: requestIdResult.value ?? "",
			is_request_root: input.is_request_root === true,
			parent_request_id: optionalString(input.parent_request_id),
			trace_id: optionalString(input.trace_id),
			service: serviceResult.value ?? "",
			instance_id: optionalString(input.instance_id),
			kind: kindResult.value ?? "",
			ts: tsResult.value ?? "",
			ended_at: endedAt,
			duration_ms: durationMs,
			outcome,
			status_code: statusCode,
			route_name: optionalString(input.route_name),
			error_name: optionalString(input.error_name),
			error_message: optionalString(input.error_message),
			data: input.data,
		},
	};
}

function validateBatchRequest(input: Record<string, unknown>): {
	batch?: AcceptedCollectorBatch;
	errors: WideCollectorRejectedEvent[];
} {
	const sentAt = optionalString(input.sent_at);
	if (!sentAt || Number.isNaN(Date.parse(sentAt))) {
		return {
			errors: [
				{
					event_id: "batch",
					reason: "sent_at must be an ISO-8601 timestamp",
				},
			],
		};
	}

	if (!isPlainObject(input.source)) {
		return {
			errors: [
				{
					event_id: "batch",
					reason: "source must be an object",
				},
			],
		};
	}

	const sourceService = optionalString(input.source.service);
	if (!sourceService) {
		return {
			errors: [
				{
					event_id: "batch",
					reason: "source.service is required",
				},
			],
		};
	}

	if (!Array.isArray(input.events) || input.events.length === 0) {
		return {
			errors: [
				{
					event_id: "batch",
					reason: "events must be a non-empty array",
				},
			],
		};
	}

	const acceptedEvents: WideCollectorEvent[] = [];
	const errors: WideCollectorRejectedEvent[] = [];
	for (const [index, event] of input.events.entries()) {
		const result = validateEvent(event, index);
		if (result.error) {
			errors.push(result.error);
			continue;
		}
		if (result.event) {
			acceptedEvents.push(result.event);
		}
	}

	return {
		batch: {
			sent_at: sentAt,
			source: {
				service: sourceService,
				instance_id: optionalString(input.source.instance_id),
			},
			events: acceptedEvents,
		},
		errors,
	};
}

function hasTerminalEvent(event: WideCollectorEvent): boolean {
	return (
		Boolean(event.ended_at) ||
		event.status_code !== undefined ||
		event.outcome !== undefined
	);
}

function isRootTerminalEvent(event: WideCollectorEvent): boolean {
	return event.is_request_root && hasTerminalEvent(event);
}

export class InMemoryActiveRequestAggregator
	implements ActiveRequestAggregator
{
	private readonly states = new Map<string, ActiveRequestState>();
	private readonly settled = new Map<string, number>();
	private readonly incompleteGraceMs: number;
	private readonly rollupVersion: number;
	private readonly dedupTtlMs: number;
	private readonly now: () => Date;

	constructor(options: InMemoryActiveRequestAggregatorOptions) {
		this.incompleteGraceMs = options.incompleteGraceMs;
		this.rollupVersion = options.rollupVersion ?? 1;
		this.dedupTtlMs = options.dedupTtlMs ?? 5 * 60_000;
		this.now = options.now ?? (() => new Date());
	}

	acceptBatch(batch: AcceptedCollectorBatch): WideRollupRecord[] {
		const rollups: WideRollupRecord[] = [];
		const emitted = new Set<string>();
		this.pruneSettled(this.now().getTime());

		for (const event of batch.events) {
			if (this.settled.has(event.request_id)) {
				continue;
			}

			const state = this.states.get(event.request_id) ?? {
				events: [],
				lastSeenAtMs: Date.parse(event.ts),
			};
			state.events.push(event);
			state.lastSeenAtMs = Math.max(state.lastSeenAtMs, Date.parse(event.ts));
			this.states.set(event.request_id, state);

			if (!isRootTerminalEvent(event) || emitted.has(event.request_id)) {
				continue;
			}

			rollups.push(this.emitRollup(event.request_id, "terminal_event"));
			emitted.add(event.request_id);
		}

		return rollups;
	}

	flushExpired(now: Date = this.now()): WideRollupRecord[] {
		const nowMs = now.getTime();
		this.pruneSettled(nowMs);
		const expired: string[] = [];

		for (const [requestId, state] of this.states.entries()) {
			if (nowMs - state.lastSeenAtMs < this.incompleteGraceMs) {
				continue;
			}
			expired.push(requestId);
		}

		return expired.map((requestId) => this.emitRollup(requestId, "timeout"));
	}

	private emitRollup(
		requestId: string,
		rollupReason: "terminal_event" | "timeout",
	): WideRollupRecord {
		const state = this.states.get(requestId);
		if (!state) {
			throw new Error(`missing active request state for ${requestId}`);
		}

		this.states.delete(requestId);
		this.settled.set(requestId, this.now().getTime() + this.dedupTtlMs);

		const canonical = buildCanonicalRequest(
			state.events.map((event) => ({
				id: event.event_id,
				type: event.kind,
				service: event.service,
				request_id: event.request_id,
				is_request_root: event.is_request_root,
				started_at: event.ts,
				ended_at: event.ended_at,
				duration_ms: event.duration_ms,
				outcome: event.outcome,
				status_code: event.status_code,
				data: event.data as ObsFields,
			})),
		);

		return {
			...canonical,
			request: canonical.request as Record<string, unknown>,
			service_map: canonical.service_map as Record<string, unknown>,
			events: state.events,
			rollup_reason: rollupReason,
			rolled_up_at: this.now().toISOString(),
			rollup_version: this.rollupVersion,
		};
	}

	private pruneSettled(nowMs: number) {
		for (const [requestId, expiresAtMs] of this.settled.entries()) {
			if (expiresAtMs > nowMs) {
				continue;
			}
			this.settled.delete(requestId);
		}
	}
}

export async function acceptCollectorBatch(
	input: Record<string, unknown>,
	deps: CollectorDependencies,
): Promise<{ status: number; body: WideCollectorBatchResponse }> {
	const { batch, errors } = validateBatchRequest(input);
	if (!batch) {
		return {
			status: 400,
			body: {
				accepted: 0,
				rejected: 0,
				request_ids: [],
				errors,
			},
		};
	}

	if (batch.events.length > 0) {
		await deps.rawEventStore.appendBatch(batch);
		const requestIds = [
			...new Set(batch.events.map((event) => event.request_id)),
		];
		const rollups = await deps.activeRequests.acceptBatch(batch);
		if (rollups.length > 0) {
			await deps.rollupStore.appendRollups(rollups);
			await dispatchRollupsForTriage(deps, rollups);
		}
		return {
			status: errors.length > 0 ? 207 : 202,
			body: {
				accepted: batch.events.length,
				rejected: errors.length,
				request_ids: requestIds,
				errors: errors.length > 0 ? errors : undefined,
			},
		};
	}

	return {
		status: 400,
		body: {
			accepted: 0,
			rejected: errors.length,
			request_ids: [],
			errors,
		},
	};
}

export async function flushExpiredCollectorRequests(
	deps: CollectorDependencies,
	now?: Date,
): Promise<number> {
	const rollups = await deps.activeRequests.flushExpired(now);
	if (rollups.length === 0) {
		return 0;
	}
	await deps.rollupStore.appendRollups(rollups);
	await dispatchRollupsForTriage(deps, rollups);
	return rollups.length;
}

async function dispatchRollupsForTriage(
	deps: CollectorDependencies,
	rollups: WideRollupRecord[],
): Promise<void> {
	if (!deps.triageDispatcher) return;
	for (const rollup of rollups) {
		await deps.triageDispatcher.dispatch(rollup);
	}
}

export async function replayCollectorFromRaw(
	deps: CollectorDependencies,
	since: Date,
	now: Date = new Date(),
): Promise<{ replayedEvents: number; emittedRollups: number }> {
	const events = await deps.rawEventStore.listEventsSince(since, now);
	events.sort((left, right) => {
		const delta = Date.parse(left.ts) - Date.parse(right.ts);
		if (delta !== 0) {
			return delta;
		}
		return left.event_id.localeCompare(right.event_id);
	});

	let emittedRollups = 0;
	for (const event of events) {
		const rollups = await deps.activeRequests.acceptBatch({
			sent_at: now.toISOString(),
			source: { service: "replay" },
			events: [event],
		});
		if (rollups.length === 0) {
			continue;
		}
		emittedRollups += rollups.length;
		await deps.rollupStore.appendRollups(rollups);
	}

	emittedRollups += await flushExpiredCollectorRequests(deps, now);
	return {
		replayedEvents: events.length,
		emittedRollups,
	};
}
