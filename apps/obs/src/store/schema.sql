CREATE TABLE IF NOT EXISTS obs_events_raw (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  service TEXT NOT NULL,
  event_type TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  duration_ms BIGINT,
  outcome TEXT,
  status_code INTEGER,
  route_name TEXT,
  error_name TEXT,
  error_message TEXT,
  data_json JSON NOT NULL,
  raw_json JSON NOT NULL,
  partition_date DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_events_raw_request_id
  ON obs_events_raw(request_id);

CREATE INDEX IF NOT EXISTS idx_obs_events_raw_started_at
  ON obs_events_raw(started_at);

CREATE INDEX IF NOT EXISTS idx_obs_events_raw_service_started_at
  ON obs_events_raw(service, started_at);

CREATE TABLE IF NOT EXISTS obs_requests_canonical (
  request_id TEXT PRIMARY KEY,
  first_ts TIMESTAMP NOT NULL,
  last_ts TIMESTAMP NOT NULL,
  total_duration_ms BIGINT NOT NULL,
  entry_service TEXT NOT NULL,
  services JSON NOT NULL,
  route_names JSON NOT NULL,
  has_terminal_event BOOLEAN NOT NULL,
  request_state TEXT NOT NULL,
  final_outcome TEXT NOT NULL,
  final_status_code INTEGER,
  event_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  primary_error JSON,
  request_json JSON NOT NULL,
  service_map_json JSON NOT NULL,
  events_json JSON NOT NULL,
  refreshed_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
