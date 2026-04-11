import type {
	CanonicalRequest,
	MergeContext,
	ObsArray,
	ObsEvent,
	ObsFields,
	ObsValue,
	ServiceSummary,
} from "../util/types";

function isPlainObject(value: ObsValue | undefined): value is ObsFields {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(
	left: ObsValue | undefined,
	right: ObsValue | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function mergeArrays(left: ObsArray, right: ObsArray): ObsArray {
	const merged = [...left];
	for (const item of right) {
		if (merged.some((existing) => valuesEqual(existing, item))) {
			continue;
		}
		merged.push(item);
	}
	return merged;
}

function appendConflict(
	target: ObsFields,
	key: string,
	left: ObsValue,
	right: ObsValue,
) {
	const existing = target._conflicts;
	const next = isPlainObject(existing) ? { ...existing } : {};
	const current = next[key];
	const values = Array.isArray(current)
		? [...current]
		: current === undefined
			? []
			: [current];

	if (!values.some((value) => valuesEqual(value as ObsValue, left))) {
		values.push(left);
	}
	if (!values.some((value) => valuesEqual(value as ObsValue, right))) {
		values.push(right);
	}

	next[key] = values;
	target._conflicts = next;
}

function mergeValues(
	left: ObsValue | undefined,
	right: ObsValue | undefined,
	context: MergeContext,
): ObsValue {
	if (left === undefined) {
		return right ?? null;
	}
	if (right === undefined || valuesEqual(left, right)) {
		return left;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return mergeArrays(left, right);
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		return mergeFields(left, right);
	}

	appendConflict(context.conflictTarget, context.conflictKey, left, right);
	return left;
}

function mergeFields(base: ObsFields, patch: ObsFields): ObsFields {
	const next: ObsFields = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const localContext: MergeContext = {
			conflictKey: key,
			conflictTarget: next,
		};
		next[key] = mergeValues(next[key], value, localContext);
	}
	return next;
}

function compareEvents(left: ObsEvent, right: ObsEvent): number {
	const delta = Date.parse(left.started_at) - Date.parse(right.started_at);
	if (delta !== 0) {
		return delta;
	}
	return left.id.localeCompare(right.id);
}

function summarizeService(events: ObsEvent[]): ServiceSummary {
	const first = events[0];
	const last = events.at(-1);
	const mergedData = events.reduce<ObsFields>(
		(acc, event) => mergeFields(acc, event.data),
		{},
	);
	const terminal = [...events]
		.reverse()
		.find(
			(event) => event.status_code !== undefined || event.outcome !== undefined,
		);

	if (!first || !last) {
		throw new Error("cannot summarize empty service event list");
	}

	return {
		service: first.service,
		first_ts: first.started_at,
		last_ts: last.ended_at ?? last.started_at,
		event_count: events.length,
		has_terminal_event: events.some(hasTerminalEvent),
		outcome: terminal?.outcome ?? last.outcome,
		status_code: terminal?.status_code ?? last.status_code,
		route_names: collectRouteNames(events),
		data: mergedData,
	};
}

function collectRouteNames(events: ObsEvent[]): string[] {
	const routes = new Set<string>();
	for (const event of events) {
		const route = event.data.route;
		if (
			!isPlainObject(route) ||
			typeof route.name !== "string" ||
			route.name.length === 0
		) {
			continue;
		}
		routes.add(route.name);
	}
	return [...routes];
}

function hasTerminalEvent(event: ObsEvent): boolean {
	return (
		Boolean(event.ended_at) ||
		event.status_code !== undefined ||
		event.outcome !== undefined
	);
}

function finalOutcome(events: ObsEvent[]): "ok" | "error" | "unknown" {
	if (!events.some(hasTerminalEvent)) {
		return "unknown";
	}
	return events.some(
		(event) => event.outcome === "error" || (event.status_code ?? 0) >= 500,
	)
		? "error"
		: "ok";
}

function finalStatusCode(events: ObsEvent[]): number | null {
	const terminal = [...events]
		.reverse()
		.find((event) => event.status_code !== undefined);
	return terminal?.status_code ?? null;
}

function primaryError(events: ObsEvent[]): ObsFields | null {
	for (const event of [...events].reverse()) {
		const error = event.data.error;
		if (isPlainObject(error)) {
			return error;
		}
	}
	return null;
}

export function buildCanonicalRequest(events: ObsEvent[]): CanonicalRequest {
	const ordered = [...events].sort(compareEvents);
	const first = ordered[0];
	const last = ordered.at(-1);

	if (!first || !last) {
		throw new Error("cannot build canonical request from zero events");
	}

	const services = [...new Set(ordered.map((event) => event.service))];
	const routeNames = [...new Set(collectRouteNames(ordered))];
	const request = ordered.reduce<ObsFields>(
		(acc, event) => mergeFields(acc, event.data),
		{},
	);
	const grouped = new Map<string, ObsEvent[]>();
	for (const event of ordered) {
		const bucket = grouped.get(event.service) ?? [];
		bucket.push(event);
		grouped.set(event.service, bucket);
	}

	const serviceMap = Object.fromEntries(
		[...grouped.entries()].map(([service, serviceEvents]) => [
			service,
			summarizeService(serviceEvents),
		]),
	);
	const hasTerminal = ordered.some(hasTerminalEvent);

	return {
		request_id: first.request_id,
		first_ts: first.started_at,
		last_ts: last.ended_at ?? last.started_at,
		total_duration_ms:
			Date.parse(last.ended_at ?? last.started_at) -
			Date.parse(first.started_at),
		entry_service: first.service,
		services,
		route_names: routeNames,
		has_terminal_event: hasTerminal,
		request_state: hasTerminal ? "completed" : "incomplete",
		final_outcome: finalOutcome(ordered),
		final_status_code: finalStatusCode(ordered),
		event_count: ordered.length,
		error_count: ordered.filter((event) => event.outcome === "error").length,
		primary_error: primaryError(ordered),
		request,
		service_map: serviceMap,
		events: ordered,
	};
}
