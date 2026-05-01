import { honoLogger, type HonoContext } from "@logtape/hono";
import {
  configure,
  configureSync,
  fromAsyncSink,
  getConsoleSink,
  getLogger,
  type LogLevel,
  type LogRecord,
  type LoggerConfig,
  type Sink,
} from "@logtape/logtape";
import type { Context, MiddlewareHandler } from "hono";

type CategoryInput = string | string[];

export interface ServerLoggingOptions {
  app?: string;
  lowestLevel?: LogLevel;
}

export interface HttpLoggingOptions {
  service: string;
  app?: string;
  level?: LogLevel;
  skip?: (c: Context) => boolean;
}

const DEFAULT_APP_CATEGORY = "red";
let configured: Promise<void> | null = null;

function normalizeCategory(category: CategoryInput): string[] {
  return Array.isArray(category) ? category : [category];
}

function appCategory(app?: string): string[] {
  return [app ?? DEFAULT_APP_CATEGORY];
}

function formatLogMessage(record: LogRecord): string {
  return record.message.map((part) => {
    if (typeof part === "string") return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join("");
}

function createLokiSink(): Sink | null {
  const lokiUrl = process.env.LOKI_URL?.trim();
  if (!lokiUrl) return null;
  return fromAsyncSink(async (record) => {
    const service = typeof record.properties.service === "string"
      ? record.properties.service
      : record.category[1] ?? "app";
    const labels = {
      app: record.category[0] ?? DEFAULT_APP_CATEGORY,
      service,
      level: record.level,
      logger: record.category.join("."),
      runtime: "bun",
    };
    const line = JSON.stringify({
      timestamp: new Date(record.timestamp).toISOString(),
      level: record.level,
      category: record.category,
      message: formatLogMessage(record),
      request_id: typeof record.properties.request_id === "string" ? record.properties.request_id : undefined,
      method: typeof record.properties.method === "string" ? record.properties.method : undefined,
      path: typeof record.properties.path === "string" ? record.properties.path : undefined,
      status: typeof record.properties.status === "number" ? record.properties.status : undefined,
      response_time_ms: typeof record.properties.response_time_ms === "number"
        ? record.properties.response_time_ms
        : undefined,
      properties: record.properties,
    });
    const response = await fetch(`${lokiUrl.replace(/\/+$/, "")}/loki/api/v1/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        streams: [
          {
            stream: labels,
            values: [[`${BigInt(record.timestamp) * 1000000n}`, line]],
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`loki push failed: ${response.status}`);
    }
  });
}

export function configureServerLogging(options: ServerLoggingOptions = {}): Promise<void> {
  if (configured) return configured;
  const root = appCategory(options.app);
  const sinks: Record<string, Sink> = {
    console: getConsoleSink() as Sink,
  };
  const configuredSinks = ["console"];
  const lokiSink = createLokiSink();
  if (lokiSink) {
    sinks.loki = lokiSink;
    configuredSinks.push("loki");
  }
  const loggers: LoggerConfig<string, string>[] = [
    {
      category: root,
      lowestLevel: options.lowestLevel ?? "info",
      sinks: configuredSinks,
    },
    {
      category: "logtape",
      lowestLevel: "error",
      sinks: configuredSinks,
    },
  ];
  const config = {
    sinks,
    loggers,
  };
  configured = lokiSink ? configure(config) : Promise.resolve(configureSync(config));
  return configured;
}

export function getServerLogger(category: CategoryInput, app?: string) {
  return getLogger([...appCategory(app), ...normalizeCategory(category)]);
}

export function createHttpLogger(options: HttpLoggingOptions): MiddlewareHandler {
  return honoLogger({
    category: [...appCategory(options.app), options.service, "http"],
    level: options.level ?? "info",
    skip: (c: HonoContext) => {
      if (options.skip?.(c as Context)) return true;
      return c.req.path === "/health" || c.req.path.startsWith("/assets/");
    },
    format: (c: HonoContext, responseTime: number) => ({
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      response_time_ms: Math.round(responseTime * 100) / 100,
      request_id: c.req.header("x-request-id"),
      user_agent: c.req.header("user-agent"),
      referrer: c.req.header("referer"),
      url: c.req.url,
    }),
  });
}
