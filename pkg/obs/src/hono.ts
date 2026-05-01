import type { Context, MiddlewareHandler } from "@red/server";
import { createEventEnvelope, type EventEnvelope, type EventSink } from "./core";

export interface ObsMiddlewareOptions {
  service: string;
  sink: EventSink;
  eventType?: string;
  requestIdHeader?: string;
}

export function obsMiddleware(
  options: ObsMiddlewareOptions,
): MiddlewareHandler<{ Variables: { envelope: EventEnvelope } }, any, any> {
  const requestIdHeader = options.requestIdHeader ?? "x-request-id";

  return async (c, next) => {
    const envelope = createEventEnvelope(c.req.raw, {
      service: options.service,
      eventType: options.eventType,
      requestIdHeader,
    });
    c.set("envelope", envelope);
    if (!c.req.raw.headers.has(requestIdHeader)) {
      c.req.raw.headers.set(requestIdHeader, envelope.requestId);
    }

    let response: Response | null = null;
    let caughtError: unknown = null;
    try {
      await next();
      const matchedRoute = normalizeRouteName((c.req as { routePath?: string }).routePath ?? "");
      if (matchedRoute && !currentRouteName(envelope)) {
        envelope.set({
          route: {
            name: matchedRoute,
          },
        });
      }
      response = c.res;
      c.header(requestIdHeader, envelope.requestId);
    } catch (error) {
      caughtError = error;
      envelope.fail(error);
      throw error;
    } finally {
      try {
        await options.sink.emit(envelope.finish(response, caughtError));
      } catch (sinkError) {
        console.error(sinkError instanceof Error ? sinkError.message : String(sinkError));
      }
    }
  };
}

function currentRouteName(envelope: EventEnvelope): string | null {
  const route = envelope.event.data.route;
  if (!route || typeof route !== "object" || Array.isArray(route)) return null;
  const name = (route as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function normalizeRouteName(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "*") return null;
  return trimmed.replace(/^\/+/, "") || "/";
}

export function getEnvelope(
  c: Context<any, any, any>,
): EventEnvelope {
  return c.get("envelope") as EventEnvelope;
}
