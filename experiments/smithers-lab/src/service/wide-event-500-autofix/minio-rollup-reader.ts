import type { S3Client } from "bun";

import {
  createS3Client,
  datePartitionsBetween,
  joinKey,
  type S3StorageConfig,
} from "../../util/s3";
import type { WideEventRollupCandidate, WideEventTerminalQuery } from "../../util/types";

type CanonicalRollupEvent = {
  request_id: string;
  is_request_root?: boolean;
  parent_request_id?: string;
  error_name?: string;
  error_message?: string;
  data?: {
    request?: {
      method?: string;
      path?: string;
    };
  };
};

type CanonicalRollupRecord = {
  request_id: string;
  entry_service: string;
  services: string[];
  route_names: string[];
  has_terminal_event: boolean;
  request_state: "completed" | "incomplete";
  final_outcome: "ok" | "error" | "unknown";
  final_status_code: number | null;
  primary_error: null | {
    name?: string | null;
    message?: string | null;
  };
  request?: {
    request?: {
      method?: string;
      path?: string;
    };
  };
  events: CanonicalRollupEvent[];
  rollup_reason: "terminal_event" | "timeout";
  rolled_up_at: string;
};

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace("http://minio:9000", "http://127.0.0.1:9003");
}

function parseNdjson<T>(text: string): T[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function normalizeErrorToken(value: string | undefined | null): string {
  return (
    (value ?? "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

function extractRoute(record: CanonicalRollupRecord): string {
  return (
    record.request?.request?.path ??
    record.events.find((event) => event.data?.request?.path)?.data?.request?.path ??
    record.route_names[0] ??
    "unknown-route"
  );
}

function extractMethod(record: CanonicalRollupRecord): string {
  return (
    record.request?.request?.method ??
    record.events.find((event) => event.data?.request?.method)?.data?.request?.method ??
    "GET"
  );
}

function isRootRequest(record: CanonicalRollupRecord): boolean {
  return record.events.some((event) => event.is_request_root === true);
}

function buildFingerprint(record: CanonicalRollupRecord, route: string): string {
  const errorName =
    record.primary_error?.name ?? record.events.find((event) => event.error_name)?.error_name;
  const errorMessage =
    record.primary_error?.message ??
    record.events.find((event) => event.error_message)?.error_message;
  const errorToken = normalizeErrorToken(errorName ?? errorMessage);

  return `${record.entry_service}:${route}:${record.final_status_code ?? "unknown"}:${errorToken}`;
}

function mapSeverity(
  record: CanonicalRollupRecord,
  occurrenceCount: number,
): "low" | "medium" | "high" | "critical" {
  if ((record.final_status_code ?? 0) >= 503 && occurrenceCount >= 3) {
    return "critical";
  }
  return "high";
}

function matchesQuery(record: CanonicalRollupRecord, query: WideEventTerminalQuery): boolean {
  if (query.requireTerminal && !record.has_terminal_event) {
    return false;
  }

  if (query.requireRootRequest && !isRootRequest(record)) {
    return false;
  }

  if (!query.requestStates.includes(record.request_state)) {
    return false;
  }

  if (!query.finalOutcomes.includes(record.final_outcome)) {
    return false;
  }

  if ((record.final_status_code ?? 0) < query.minStatusCode) {
    return false;
  }

  if (query.services.length > 0) {
    const services = new Set([record.entry_service, ...record.services]);
    if (!query.services.some((service) => services.has(service))) {
      return false;
    }
  }

  if (query.routes.length > 0) {
    const route = extractRoute(record);
    if (!query.routes.includes(route)) {
      return false;
    }
  }

  return true;
}

async function listAllKeys(client: S3Client, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.list({
      prefix,
      continuationToken,
      maxKeys: 1000,
    });
    for (const entry of response.contents ?? []) {
      keys.push(entry.key);
    }
    continuationToken = response.nextContinuationToken;
  } while (continuationToken);

  return keys;
}

export class MinioWideEventRollupReader {
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly now: () => Date;

  constructor(config: S3StorageConfig, opts: { now?: () => Date; client?: S3Client } = {}) {
    this.client =
      opts.client ??
      createS3Client({
        ...config,
        endpoint: normalizeEndpoint(config.endpoint),
      });
    this.prefix = config.prefix;
    this.now = opts.now ?? (() => new Date());
  }

  async listTerminalCandidates(query: WideEventTerminalQuery): Promise<WideEventRollupCandidate[]> {
    const since = new Date(query.since);
    const now = this.now();
    const prefixes = datePartitionsBetween(since, now).map((date) =>
      joinKey(this.prefix, `date=${date}`),
    );

    const records: CanonicalRollupRecord[] = [];
    for (const prefix of prefixes) {
      const keys = await listAllKeys(this.client, prefix);
      for (const key of keys) {
        const text = await this.client.file(key).text();
        for (const record of parseNdjson<CanonicalRollupRecord>(text)) {
          if (Date.parse(record.rolled_up_at) >= since.getTime()) {
            records.push(record);
          }
        }
      }
    }

    const filtered = records.filter((record) => matchesQuery(record, query));
    const fingerprintCounts = new Map<string, number>();
    for (const record of filtered) {
      const fingerprint = buildFingerprint(record, extractRoute(record));
      fingerprintCounts.set(fingerprint, (fingerprintCounts.get(fingerprint) ?? 0) + 1);
    }

    return filtered
      .sort((left, right) => Date.parse(right.rolled_up_at) - Date.parse(left.rolled_up_at))
      .slice(0, query.limit)
      .map((record) => {
        const route = extractRoute(record);
        const fingerprint = buildFingerprint(record, route);
        const occurrenceCount = fingerprintCounts.get(fingerprint) ?? 1;

        return {
          requestId: record.request_id,
          parentRequestId: record.events.find((event) => event.parent_request_id)
            ?.parent_request_id,
          isRootRequest: isRootRequest(record),
          service: record.entry_service,
          route,
          method: extractMethod(record),
          statusCode: record.final_status_code ?? query.minStatusCode,
          requestState: record.request_state,
          rolledUpAt: record.rolled_up_at,
          rollupReason: record.rollup_reason,
          errorMessage:
            record.primary_error?.message ??
            record.events.find((event) => event.error_message)?.error_message,
          fingerprint,
          occurrenceCount,
          windowMinutes: Math.max(1, Math.round((now.getTime() - since.getTime()) / 60000)),
          severity: mapSeverity(record, occurrenceCount),
        };
      });
  }
}

export function createMinioWideEventRollupReaderFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const endpoint = env.WIDE_EVENTS_S3_ENDPOINT?.trim();
  const region = env.WIDE_EVENTS_S3_REGION?.trim();
  const accessKeyId = env.WIDE_EVENTS_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.WIDE_EVENTS_S3_SECRET_ACCESS_KEY?.trim();
  const bucket = env.WIDE_EVENTS_ROLLUP_BUCKET?.trim();
  const prefix = env.WIDE_EVENTS_ROLLUP_PREFIX?.trim();

  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket || !prefix) {
    return null;
  }

  return new MinioWideEventRollupReader({
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix,
  });
}
