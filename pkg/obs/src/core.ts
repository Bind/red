import { randomUUID } from "node:crypto";

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
  is_request_root: boolean;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  outcome?: "ok" | "error";
  status_code?: number;
  data: ObsFields;
}

export interface EventEnvelope {
  readonly event: ObsEvent;
  readonly requestId: string;
  set(fields: ObsFields): void;
  fail(error: unknown): void;
  finish(response: Response | null, error?: unknown): ObsEvent;
}

export interface EventSink {
  emit(event: ObsEvent): void | Promise<void>;
}

export interface CreateEnvelopeOptions {
  service: string;
  eventType?: string;
  requestIdHeader?: string;
}

export interface HealthCheckResult {
  status?: "ok" | "error";
  [key: string]: ObsValue | undefined;
}

export interface HealthReporterOptions {
  service: string;
  startedAtMs: number;
  checks: Record<string, () => Promise<HealthCheckResult | void> | HealthCheckResult | void>;
}

export interface HealthReport {
  status: "ok" | "error";
  service: string;
  time: string;
  uptime_ms: number;
  checks: Record<string, HealthCheckResult>;
}

function isPlainObject(value: unknown): value is ObsFields {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeFields(base: ObsFields, patch: ObsFields): ObsFields {
  const next: ObsFields = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = mergeFields(current, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function buildRequestFields(request: Request): ObsFields {
  const url = new URL(request.url);
  const forwardedFor = request.headers.get("x-forwarded-for");
  return {
    request: {
      method: request.method,
      path: url.pathname,
      host: url.host,
      scheme: url.protocol.replace(":", ""),
    },
    client: {
      ip: forwardedFor?.split(",")[0]?.trim() || null,
      user_agent: request.headers.get("user-agent"),
    },
    http: {
      origin: request.headers.get("origin"),
      referer: request.headers.get("referer"),
      content_type: request.headers.get("content-type"),
    },
  };
}

export function createEventEnvelope(
  request: Request,
  options: CreateEnvelopeOptions,
): EventEnvelope {
  const startedAtMs = Date.now();
  const requestIdHeader = options.requestIdHeader ?? "x-request-id";
  const incomingRequestId = request.headers.get(requestIdHeader)?.trim();
  const requestId = incomingRequestId || randomUUID();
  const event: ObsEvent = {
    id: randomUUID(),
    type: options.eventType ?? "request",
    service: options.service,
    request_id: requestId,
    is_request_root: !incomingRequestId,
    started_at: new Date(startedAtMs).toISOString(),
    data: buildRequestFields(request),
  };

  return {
    event,
    requestId,
    set(fields) {
      event.data = mergeFields(event.data, fields);
    },
    fail(error) {
      if (!(error instanceof Error)) {
        return;
      }
      event.data = mergeFields(event.data, {
        error: {
          name: error.name,
          message: error.message,
        },
      });
    },
    finish(response, error) {
      const endedAtMs = Date.now();
      event.ended_at = new Date(endedAtMs).toISOString();
      event.duration_ms = endedAtMs - startedAtMs;
      event.status_code = response?.status ?? 500;
      event.outcome = response && response.status < 500 ? "ok" : "error";

      if (response) {
        event.data = mergeFields(event.data, {
          response: {
            content_type: response.headers.get("content-type"),
          },
        });
      }

      if (error instanceof Error) {
        this.fail(error);
      }

      return event;
    },
  };
}

export class ConsoleJsonSink implements EventSink {
  emit(event: ObsEvent): void {
    console.info(JSON.stringify(event));
  }
}

export class MemorySink implements EventSink {
  readonly events: ObsEvent[] = [];

  emit(event: ObsEvent): void {
    this.events.push(event);
  }
}

export async function collectHealthReport(
  options: HealthReporterOptions,
): Promise<HealthReport> {
  const checks: Record<string, HealthCheckResult> = {};
  let status: "ok" | "error" = "ok";

  for (const [name, check] of Object.entries(options.checks)) {
    try {
      const result = (await check()) ?? {};
      const normalized: HealthCheckResult = {
        status: result.status ?? "ok",
        ...result,
      };
      checks[name] = normalized;
      if (normalized.status === "error") {
        status = "error";
      }
    } catch (error) {
      status = "error";
      checks[name] = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    status,
    service: options.service,
    time: new Date().toISOString(),
    uptime_ms: Date.now() - options.startedAtMs,
    checks,
  };
}
