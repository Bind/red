export interface WideCollectorSource {
	service: string;
	instance_id?: string;
}

export interface WideCollectorEvent {
	event_id: string;
	request_id: string;
	parent_request_id?: string;
	trace_id?: string;
	service: string;
	instance_id?: string;
	kind: string;
	ts: string;
	ended_at?: string;
	duration_ms?: number;
	outcome?: "ok" | "error";
	status_code?: number;
	route_name?: string;
	error_name?: string;
	error_message?: string;
	data: Record<string, unknown>;
}

export interface WideCollectorBatchRequest {
	sent_at: string;
	source: WideCollectorSource;
	events: WideCollectorEvent[];
}

export interface WideCollectorRejectedEvent {
	event_id: string;
	reason: string;
}

export interface WideCollectorBatchResponse {
	accepted: number;
	rejected: number;
	request_ids: string[];
	errors?: WideCollectorRejectedEvent[];
}

export interface WideRollupRecord {
	request_id: string;
	first_ts: string;
	last_ts: string;
	total_duration_ms: number;
	entry_service: string;
	services: string[];
	route_names: string[];
	has_terminal_event: boolean;
	request_state: "completed" | "incomplete";
	final_outcome: "ok" | "error" | "unknown";
	final_status_code: number | null;
	event_count: number;
	error_count: number;
	primary_error: Record<string, unknown> | null;
	request: Record<string, unknown>;
	service_map: Record<string, unknown>;
	events: WideCollectorEvent[];
	rollup_reason: "terminal_event" | "timeout";
	rolled_up_at: string;
	rollup_version: number;
}
