export type ObsPrimitive = string | number | boolean | null;
export interface ObsArray extends Array<ObsValue> {}
export interface ObsFields {
	[key: string]: ObsValue;
}
export type ObsValue = ObsPrimitive | ObsFields | ObsArray;

export interface ObsEvent {
	id: string;
	type: string;
	service: string;
	request_id: string;
	started_at: string;
	ended_at?: string;
	duration_ms?: number;
	outcome?: "ok" | "error";
	status_code?: number;
	data: ObsFields;
}

export interface ServiceSummary {
	service: string;
	first_ts: string;
	last_ts: string;
	event_count: number;
	has_terminal_event: boolean;
	outcome?: "ok" | "error";
	status_code?: number;
	route_names: string[];
	data: ObsFields;
}

export interface CanonicalRequest {
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
	primary_error: ObsFields | null;
	request: ObsFields;
	service_map: Record<string, ServiceSummary>;
	events: ObsEvent[];
}

export interface MergeContext {
	conflictKey: string;
	conflictTarget: ObsFields;
}
