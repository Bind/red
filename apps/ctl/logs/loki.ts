const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10000;

export interface LogQueryInput {
  service?: string;
  level?: string;
  logger?: "all" | "http";
  search?: string;
  window?: string;
  limit?: number;
  statusCode?: number;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx";
}

export interface LogEntry {
  timestamp: string;
  service: string;
  level: string;
  logger: string;
  message: string;
  requestId: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  responseTimeMs: number | null;
  properties: Record<string, unknown>;
  line: Record<string, unknown> | null;
}

export interface LogCount {
  value: string;
  count: number;
}

export interface LogTimelineBucket {
  minute: string;
  total: number;
  errors: number;
  status5xx: number;
}

export interface LogSummary {
  total: number;
  serviceCounts: LogCount[];
  levelCounts: LogCount[];
  statusCounts: LogCount[];
  statusClassCounts: LogCount[];
  timeline: LogTimelineBucket[];
}

export interface LogQueryResult {
  query: {
    service: string | null;
    level: string | null;
    logger: "all" | "http";
    search: string | null;
    window: string;
    limit: number;
    statusCode: number | null;
    statusClass: LogQueryInput["statusClass"] | null;
  };
  entries: LogEntry[];
  summary: LogSummary;
}

export interface LogStreamEvent {
  id: string;
  timestampNs: string;
  entry: LogEntry;
}

interface LokiQueryRangeResponse {
  data?: {
    result?: Array<{
      stream?: Record<string, string>;
      values?: Array<[string, string]>;
    }>;
  };
}

interface LokiQueryOptions {
  startNs?: string;
  endNs?: string;
  limit?: number;
  direction?: "BACKWARD" | "FORWARD";
}

function requireLokiUrl(): string {
  const value = process.env.LOKI_URL?.trim();
  if (!value) {
    throw new Error("LOKI_URL is required for log queries");
  }
  return value.replace(/\/+$/, "");
}

function coerceLimit(value?: number): number {
  const numeric = Number.isFinite(value) ? Number(value) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(numeric)));
}

function parseWindowToMs(value?: string): number {
  const raw = (value ?? "1h").trim();
  const match = raw.match(/^(\d+)([mhd])$/);
  if (!match) return 60 * 60 * 1000;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeLogqlString(value: string): string {
  return JSON.stringify(value);
}

function buildLogql(query: LogQueryInput): string {
  const selectorParts = ['app="red"'];
  if (query.service && query.service !== "all") {
    selectorParts.push(`service="${escapeLabelValue(query.service)}"`);
  }
  if (query.level && query.level !== "all") {
    selectorParts.push(`level="${escapeLabelValue(query.level)}"`);
  }
  if (query.logger === "http") {
    selectorParts.push('logger=~".*\\\\.http"');
  }
  let expression = `{${selectorParts.join(",")}}`;
  if (query.search) {
    expression += ` |= ${escapeLogqlString(query.search)}`;
  }
  return expression;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEntry(stream: Record<string, string>, timestampNs: string, line: string): LogEntry {
  const parsed = parseJsonLine(line);
  const properties = parsed?.properties && typeof parsed.properties === "object"
    ? parsed.properties as Record<string, unknown>
    : {};
  const timestamp = Number.parseInt(timestampNs.slice(0, -6) || "0", 10);
  return {
    timestamp: asString(parsed?.timestamp) ?? new Date(timestamp).toISOString(),
    service: stream.service ?? "unknown",
    level: stream.level ?? asString(parsed?.level) ?? "info",
    logger: stream.logger ?? "unknown",
    message: asString(parsed?.message) ?? line,
    requestId: asString(properties.request_id) ?? asString(parsed?.request_id),
    method: asString(properties.method) ?? asString(parsed?.method),
    path: asString(properties.path) ?? asString(parsed?.path),
    status: asNumber(properties.status) ?? asNumber(parsed?.status),
    responseTimeMs: asNumber(properties.response_time_ms) ?? asNumber(parsed?.response_time_ms),
    properties,
    line: parsed,
  };
}

function buildStreamEvent(stream: Record<string, string>, timestampNs: string, line: string): LogStreamEvent {
  const entry = normalizeEntry(stream, timestampNs, line);
  return {
    id: `${timestampNs}:${entry.service}:${entry.logger}:${entry.requestId ?? entry.path ?? entry.message.slice(0, 64)}`,
    timestampNs,
    entry,
  };
}

function matchesStatusFilter(entry: LogEntry, query: LogQueryInput): boolean {
  if (query.statusCode !== undefined && query.statusCode !== null) {
    return entry.status === query.statusCode;
  }
  if (!query.statusClass) return true;
  if (entry.status === null) return false;
  if (query.statusClass === "2xx") return entry.status >= 200 && entry.status < 300;
  if (query.statusClass === "3xx") return entry.status >= 300 && entry.status < 400;
  if (query.statusClass === "4xx") return entry.status >= 400 && entry.status < 500;
  return entry.status >= 500 && entry.status < 600;
}

function sortCounts(map: Map<string, number>): LogCount[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

function buildSummary(entries: LogEntry[]): LogSummary {
  const serviceCounts = new Map<string, number>();
  const levelCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const statusClassCounts = new Map<string, number>();
  const timeline = new Map<string, LogTimelineBucket>();

  for (const entry of entries) {
    serviceCounts.set(entry.service, (serviceCounts.get(entry.service) ?? 0) + 1);
    levelCounts.set(entry.level, (levelCounts.get(entry.level) ?? 0) + 1);

    if (entry.status !== null) {
      const statusText = String(entry.status);
      statusCounts.set(statusText, (statusCounts.get(statusText) ?? 0) + 1);
      const statusClass = `${Math.floor(entry.status / 100)}xx`;
      statusClassCounts.set(statusClass, (statusClassCounts.get(statusClass) ?? 0) + 1);
    }

    const minute = entry.timestamp.slice(0, 16);
    const bucket = timeline.get(minute) ?? {
      minute,
      total: 0,
      errors: 0,
      status5xx: 0,
    };
    bucket.total += 1;
    if (entry.level === "error") bucket.errors += 1;
    if (entry.status !== null && entry.status >= 500) bucket.status5xx += 1;
    timeline.set(minute, bucket);
  }

  return {
    total: entries.length,
    serviceCounts: sortCounts(serviceCounts),
    levelCounts: sortCounts(levelCounts),
    statusCounts: sortCounts(statusCounts),
    statusClassCounts: sortCounts(statusClassCounts),
    timeline: Array.from(timeline.values()).sort((a, b) => a.minute.localeCompare(b.minute)),
  };
}

export async function queryLokiLogs(input: LogQueryInput = {}): Promise<LogQueryResult> {
  const lokiUrl = requireLokiUrl();
  const limit = coerceLimit(input.limit);
  const endMs = Date.now();
  const startMs = endMs - parseWindowToMs(input.window);
  const rows = await queryLokiLogEvents(input, {
    startNs: `${BigInt(startMs) * 1000000n}`,
    endNs: `${BigInt(endMs) * 1000000n}`,
    limit: Math.max(limit * 3, 500),
    direction: "BACKWARD",
  });
  const sortedRows = rows
    .map((row) => row.entry)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const entries = sortedRows.slice(0, limit);
  return {
    query: {
      service: input.service && input.service !== "all" ? input.service : null,
      level: input.level && input.level !== "all" ? input.level : null,
      logger: input.logger ?? "all",
      search: input.search?.trim() ? input.search.trim() : null,
      window: input.window?.trim() || "1h",
      limit,
      statusCode: input.statusCode ?? null,
      statusClass: input.statusClass ?? null,
    },
    entries,
    summary: buildSummary(sortedRows),
  };
}

export async function queryLokiLogEvents(
  input: LogQueryInput = {},
  options: LokiQueryOptions = {},
): Promise<LogStreamEvent[]> {
  const lokiUrl = requireLokiUrl();
  const limit = coerceLimit(options.limit ?? input.limit);
  const endNs = options.endNs ?? `${BigInt(Date.now()) * 1000000n}`;
  const startNs = options.startNs ?? `${BigInt(Date.now() - parseWindowToMs(input.window)) * 1000000n}`;
  const params = new URLSearchParams({
    query: buildLogql(input),
    start: startNs,
    end: endNs,
    limit: String(limit),
    direction: options.direction ?? "FORWARD",
  });
  const response = await fetch(`${lokiUrl}/loki/api/v1/query_range?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`loki query failed: ${response.status}`);
  }

  const payload = await response.json() as LokiQueryRangeResponse;
  return (payload.data?.result ?? [])
    .flatMap((streamResult) => {
      const stream = streamResult.stream ?? {};
      return (streamResult.values ?? []).map(([timestampNs, line]) => buildStreamEvent(stream, timestampNs, line));
    })
    .filter((event) => matchesStatusFilter(event.entry, input))
    .sort((a, b) => a.timestampNs.localeCompare(b.timestampNs));
}
