WITH recent AS (
  SELECT *
  FROM obs_requests_canonical
  WHERE first_ts >= current_timestamp - INTERVAL 15 MINUTE
    AND request_state = 'completed'
),
baseline AS (
  SELECT
    entry_service,
    unnest(json_extract_string(route_names, '$[*]')) AS route_name,
    avg(total_duration_ms) AS baseline_duration_ms,
    avg(CASE WHEN final_outcome = 'error' THEN 1.0 ELSE 0.0 END) AS baseline_error_rate
  FROM obs_requests_canonical
  WHERE first_ts >= current_timestamp - INTERVAL 24 HOUR
    AND first_ts < current_timestamp - INTERVAL 15 MINUTE
    AND request_state = 'completed'
  GROUP BY 1, 2
),
current_window AS (
  SELECT
    entry_service,
    unnest(json_extract_string(route_names, '$[*]')) AS route_name,
    count(*) AS request_count,
    avg(total_duration_ms) AS avg_duration_ms,
    avg(CASE WHEN final_outcome = 'error' THEN 1.0 ELSE 0.0 END) AS error_rate
  FROM recent
  GROUP BY 1, 2
)
SELECT
  current_window.entry_service,
  current_window.route_name,
  current_window.request_count,
  current_window.avg_duration_ms,
  current_window.error_rate,
  baseline.baseline_duration_ms,
  baseline.baseline_error_rate
FROM current_window
LEFT JOIN baseline USING (entry_service, route_name)
WHERE current_window.request_count >= 20
  AND (
    current_window.error_rate >= 0.10
    OR current_window.avg_duration_ms >= coalesce(baseline.baseline_duration_ms, 0) * 2
  )
ORDER BY current_window.error_rate DESC, current_window.avg_duration_ms DESC;
