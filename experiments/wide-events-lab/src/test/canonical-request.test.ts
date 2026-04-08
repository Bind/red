import { describe, expect, test } from "bun:test";
import { buildCanonicalRequest } from "../service/canonical-request";
import type { ObsEvent } from "../util/types";

function event(overrides: Partial<ObsEvent>): ObsEvent {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		type: overrides.type ?? "request",
		service: overrides.service ?? "api",
		request_id: overrides.request_id ?? "req-1",
		started_at: overrides.started_at ?? "2026-04-08T10:00:00.000Z",
		ended_at: overrides.ended_at,
		duration_ms: overrides.duration_ms,
		outcome: overrides.outcome,
		status_code: overrides.status_code,
		data: overrides.data ?? {},
	};
}

describe("buildCanonicalRequest", () => {
	test("merges events from multiple services into one canonical request", () => {
		const canonical = buildCanonicalRequest([
			event({
				id: "1",
				service: "bff",
				started_at: "2026-04-08T10:00:00.000Z",
				ended_at: "2026-04-08T10:00:00.020Z",
				outcome: "ok",
				status_code: 202,
				data: {
					request: { method: "POST", path: "/session/exchange" },
					route: { name: "session_exchange" },
					auth: { actor: "user-123" },
				},
			}),
			event({
				id: "2",
				service: "auth",
				started_at: "2026-04-08T10:00:00.005Z",
				ended_at: "2026-04-08T10:00:00.030Z",
				outcome: "error",
				status_code: 500,
				data: {
					route: { name: "session_exchange" },
					upstream: { service: "auth" },
					error: { name: "AuthError", message: "token exchange failed" },
				},
			}),
			event({
				id: "3",
				service: "bff",
				started_at: "2026-04-08T10:00:00.031Z",
				ended_at: "2026-04-08T10:00:00.040Z",
				outcome: "error",
				status_code: 500,
				data: {
					response: { content_type: "application/json" },
				},
			}),
		]);

		expect(canonical.request_id).toBe("req-1");
		expect(canonical.entry_service).toBe("bff");
		expect(canonical.services).toEqual(["bff", "auth"]);
		expect(canonical.route_names).toEqual(["session_exchange"]);
		expect(canonical.has_terminal_event).toBe(true);
		expect(canonical.request_state).toBe("completed");
		expect(canonical.final_outcome).toBe("error");
		expect(canonical.final_status_code).toBe(500);
		expect(canonical.event_count).toBe(3);
		expect(canonical.error_count).toBe(2);
		expect(canonical.primary_error).toEqual({
			name: "AuthError",
			message: "token exchange failed",
		});
		expect(canonical.service_map.auth?.event_count).toBe(1);
		expect((canonical.request.request as Record<string, unknown>).path).toBe(
			"/session/exchange",
		);
		expect(
			(canonical.request.response as Record<string, unknown>).content_type,
		).toBe("application/json");
	});

	test("preserves scalar conflicts instead of silently overwriting them", () => {
		const canonical = buildCanonicalRequest([
			event({
				id: "1",
				data: {
					request: { host: "bff.internal" },
				},
			}),
			event({
				id: "2",
				service: "api",
				started_at: "2026-04-08T10:00:00.010Z",
				data: {
					request: { host: "api.internal" },
				},
			}),
		]);

		const request = canonical.request.request as Record<string, unknown>;
		expect(request.host).toBe("bff.internal");
		expect(request._conflicts).toEqual({
			host: ["bff.internal", "api.internal"],
		});
	});

	test("marks requests without a terminal event as incomplete", () => {
		const canonical = buildCanonicalRequest([
			event({
				id: "1",
				service: "bff",
				started_at: "2026-04-08T10:00:00.000Z",
				data: {
					request: { method: "GET", path: "/changes" },
					route: { name: "changes_list" },
				},
			}),
			event({
				id: "2",
				service: "api",
				started_at: "2026-04-08T10:00:00.005Z",
				data: {
					upstream: { service: "api" },
				},
			}),
		]);

		expect(canonical.has_terminal_event).toBe(false);
		expect(canonical.request_state).toBe("incomplete");
		expect(canonical.final_outcome).toBe("unknown");
		expect(canonical.final_status_code).toBeNull();
		expect(canonical.service_map.bff?.has_terminal_event).toBe(false);
		expect(canonical.service_map.api?.has_terminal_event).toBe(false);
	});
});
