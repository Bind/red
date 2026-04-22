import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConsoleJsonSink, type EventSink, type ObsEvent } from "./core";

type FetchLike = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CollectorWideEvent {
  event_id: string;
  request_id: string;
  is_request_root: boolean;
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

export interface CollectorSource {
  service: string;
  instance_id?: string;
}

export interface CollectorBatchRequest {
  sent_at: string;
  source: CollectorSource;
  events: CollectorWideEvent[];
}

export interface CollectorRejectedEvent {
  event_id: string;
  reason: string;
}

export interface CollectorBatchResponse {
  accepted: number;
  rejected: number;
  request_ids: string[];
  errors?: CollectorRejectedEvent[];
}

export interface CollectorEventMappingOptions {
  service?: string;
  instanceId?: string;
  kind?: string;
}

export interface HttpBatchSinkOptions {
  endpoint: string;
  source: CollectorSource;
  authToken?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  fetchImpl?: FetchLike;
}

export interface FileNdjsonSinkOptions {
  filePath: string;
  service?: string;
  instanceId?: string;
}

export interface CollectorSinkEnvOptions {
  service: string;
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FlushableEventSink extends EventSink {
  flush(): Promise<void>;
}

function envString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toCollectorWideEvent(
  event: ObsEvent,
  options: CollectorEventMappingOptions = {},
): CollectorWideEvent {
  const route = event.data.route;
  const error = event.data.error;

  return {
    event_id: event.id,
    request_id: event.request_id,
    is_request_root: event.is_request_root,
    service: options.service ?? event.service,
    instance_id: options.instanceId,
    kind: options.kind ?? event.type,
    ts: event.started_at,
    ended_at: event.ended_at,
    duration_ms: event.duration_ms,
    outcome: event.outcome,
    status_code: event.status_code,
    route_name:
      isPlainObject(route) && typeof route.name === "string" ? route.name : undefined,
    error_name:
      isPlainObject(error) && typeof error.name === "string" ? error.name : undefined,
    error_message:
      isPlainObject(error) && typeof error.message === "string"
        ? error.message
        : undefined,
    data: event.data as Record<string, unknown>,
  };
}

export class FileNdjsonSink implements EventSink {
  private readonly filePath: string;
  private readonly service?: string;
  private readonly instanceId?: string;

  constructor(options: FileNdjsonSinkOptions) {
    this.filePath = resolve(options.filePath);
    this.service = options.service;
    this.instanceId = options.instanceId;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  emit(event: ObsEvent): void {
    const mapped = toCollectorWideEvent(event, {
      service: this.service,
      instanceId: this.instanceId,
    });
    appendFileSync(this.filePath, `${JSON.stringify(mapped)}\n`, "utf8");
  }
}

export class HttpBatchSink implements FlushableEventSink {
  private readonly endpoint: string;
  private readonly source: CollectorSource;
  private readonly authToken?: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly fetchImpl: FetchLike;
  private readonly queue: CollectorWideEvent[] = [];
  private timer: Timer | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: HttpBatchSinkOptions) {
    this.endpoint = options.endpoint;
    this.source = options.source;
    this.authToken = options.authToken;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  emit(event: ObsEvent): void {
    this.queue.push(
      toCollectorWideEvent(event, {
        service: this.source.service,
        instanceId: this.source.instance_id,
      }),
    );
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
      return;
    }
    this.ensureTimer();
  }

  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    if (this.queue.length === 0) {
      this.clearTimer();
      return;
    }

    const events = this.queue.splice(0, this.maxBatchSize);
    this.clearTimer();
    this.inFlight = this.sendBatch(events).finally(() => {
      this.inFlight = null;
      if (this.queue.length > 0) {
        this.ensureTimer();
      }
    });
    await this.inFlight;
  }

  private ensureTimer() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private clearTimer() {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async sendBatch(events: CollectorWideEvent[]) {
    const request: CollectorBatchRequest = {
      sent_at: new Date().toISOString(),
      source: this.source,
      events,
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`collector rejected batch with status ${response.status}`);
    }

    const body = (await response.json()) as CollectorBatchResponse;
    if (body.rejected > 0) {
      throw new Error(
        `collector rejected ${body.rejected} events: ${JSON.stringify(body.errors ?? [])}`,
      );
    }
  }
}

export function createObsSinkFromEnv(
  options: CollectorSinkEnvOptions,
): EventSink {
  const env = options.env ?? process.env;
  const mode = envString(env.OBS_SINK_MODE) ?? "console";

  if (isTestEnvironment(env)) {
    return new ConsoleJsonSink();
  }

  if (mode === "file") {
    const filePath = envString(env.OBS_FILE_PATH);
    if (!filePath) {
      throw new Error("OBS_FILE_PATH is required when OBS_SINK_MODE=file");
    }
    return new FileNdjsonSink({
      filePath,
      service: options.service,
      instanceId: options.instanceId,
    });
  }

  if (mode === "collector") {
    const baseUrl = envString(env.WIDE_EVENTS_COLLECTOR_URL);
    if (!baseUrl) {
      throw new Error(
        "WIDE_EVENTS_COLLECTOR_URL is required when OBS_SINK_MODE=collector",
      );
    }
    const endpoint = baseUrl.endsWith("/v1/events")
      ? baseUrl
      : `${baseUrl.replace(/\/+$/, "")}/v1/events`;
    const flushIntervalMs = envString(env.OBS_FLUSH_INTERVAL_MS);
    const maxBatchSize = envString(env.OBS_MAX_BATCH_SIZE);

    return new HttpBatchSink({
      endpoint,
      source: {
        service: options.service,
        instance_id: options.instanceId ?? envString(env.OBS_INSTANCE_ID),
      },
      authToken: envString(env.OBS_AUTH_TOKEN),
      flushIntervalMs: flushIntervalMs
        ? Number.parseInt(flushIntervalMs, 10)
        : undefined,
      maxBatchSize: maxBatchSize
        ? Number.parseInt(maxBatchSize, 10)
        : undefined,
    });
  }

  return new ConsoleJsonSink();
}
