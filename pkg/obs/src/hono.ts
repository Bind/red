import type { Context, MiddlewareHandler } from "hono";
import { createEventEnvelope, type EventEnvelope, type EventSink } from "./core";

export interface ObsMiddlewareOptions {
  service: string;
  sink: EventSink;
  eventType?: string;
  requestIdHeader?: string;
}

export function obsMiddleware(
  options: ObsMiddlewareOptions,
): MiddlewareHandler<{ Variables: { envelope: EventEnvelope } }> {
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

export function getEnvelope(
  c: Context<{ Variables: { envelope: EventEnvelope } }>,
): EventEnvelope {
  return c.get("envelope");
}
