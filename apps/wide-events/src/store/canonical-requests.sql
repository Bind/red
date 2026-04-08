INSERT OR REPLACE INTO obs_requests_canonical (
  request_id,
  first_ts,
  last_ts,
  total_duration_ms,
  entry_service,
  services,
  route_names,
  has_terminal_event,
  request_state,
  final_outcome,
  final_status_code,
  event_count,
  error_count,
  primary_error,
  request_json,
  service_map_json,
  events_json,
  refreshed_at
)
WITH ordered AS (
  SELECT
    event_id,
    request_id,
    service,
    event_type,
    started_at,
    ended_at,
    duration_ms,
    outcome,
    status_code,
    route_name,
    error_name,
    error_message,
    data_json,
    raw_json,
    row_number() OVER (
      PARTITION BY request_id
      ORDER BY started_at ASC, event_id ASC
    ) AS seq_asc,
    row_number() OVER (
      PARTITION BY request_id
      ORDER BY coalesce(ended_at, started_at) DESC, event_id DESC
    ) AS seq_desc
  FROM obs_events_raw
),
request_bounds AS (
  SELECT
    request_id,
    min(started_at) AS first_ts,
    max(coalesce(ended_at, started_at)) AS last_ts,
    min_by(service, started_at) AS entry_service,
    to_json(list(DISTINCT service ORDER BY service)) AS services,
    to_json(list(DISTINCT route_name ORDER BY route_name) FILTER (WHERE route_name IS NOT NULL)) AS route_names,
    count(*) FILTER (
      WHERE ended_at IS NOT NULL OR status_code IS NOT NULL OR outcome IS NOT NULL
    ) > 0 AS has_terminal_event,
    count(*) AS event_count,
    count(*) FILTER (WHERE outcome = 'error') AS error_count,
    CASE
      WHEN count(*) FILTER (
        WHERE ended_at IS NOT NULL OR status_code IS NOT NULL OR outcome IS NOT NULL
      ) = 0 THEN 'unknown'
      WHEN count(*) FILTER (WHERE outcome = 'error' OR status_code >= 500) > 0 THEN 'error'
      ELSE 'ok'
    END AS final_outcome
  FROM ordered
  GROUP BY request_id
),
latest_terminal AS (
  SELECT
    request_id,
    status_code AS final_status_code
  FROM ordered
  WHERE seq_desc = 1
),
latest_error AS (
  SELECT
    request_id,
    CASE
      WHEN error_name IS NULL AND error_message IS NULL THEN NULL
      ELSE json_object('name', error_name, 'message', error_message)
    END AS primary_error
  FROM ordered
  WHERE error_name IS NOT NULL OR error_message IS NOT NULL
  QUALIFY row_number() OVER (
    PARTITION BY request_id
    ORDER BY coalesce(ended_at, started_at) DESC, event_id DESC
  ) = 1
),
merged_request AS (
  SELECT
    request_id,
    json_group_object(service, json_object(
      'first_ts', min(started_at),
      'last_ts', max(coalesce(ended_at, started_at)),
      'event_count', count(*),
      'has_terminal_event', count(*) FILTER (
        WHERE ended_at IS NOT NULL OR status_code IS NOT NULL OR outcome IS NOT NULL
      ) > 0,
      'route_names', to_json(list(DISTINCT route_name ORDER BY route_name) FILTER (WHERE route_name IS NOT NULL)),
      'outcome', max_by(outcome, coalesce(ended_at, started_at)),
      'status_code', max_by(status_code, coalesce(ended_at, started_at)),
      'events', to_json(list(raw_json ORDER BY started_at, event_id))
    )) AS service_map_json,
    to_json(list(raw_json ORDER BY started_at, event_id)) AS events_json,
    to_json(list(data_json ORDER BY started_at, event_id)) AS request_json_parts
  FROM ordered
  GROUP BY request_id
)
SELECT
  bounds.request_id,
  bounds.first_ts,
  bounds.last_ts,
  date_diff('millisecond', bounds.first_ts, bounds.last_ts) AS total_duration_ms,
  bounds.entry_service,
  bounds.services,
  coalesce(bounds.route_names, '[]') AS route_names,
  bounds.has_terminal_event,
  CASE
    WHEN bounds.has_terminal_event THEN 'completed'
    ELSE 'incomplete'
  END AS request_state,
  bounds.final_outcome,
  terminal.final_status_code,
  bounds.event_count,
  bounds.error_count,
  latest_error.primary_error,
  merged.request_json_parts AS request_json,
  merged.service_map_json,
  merged.events_json,
  current_timestamp
FROM request_bounds AS bounds
LEFT JOIN latest_terminal AS terminal USING (request_id)
LEFT JOIN latest_error USING (request_id)
LEFT JOIN merged_request AS merged USING (request_id);
