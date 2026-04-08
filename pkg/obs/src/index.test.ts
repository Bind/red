import { describe, expect, test } from "bun:test";
import { collectHealthReport, createEventEnvelope, MemorySink } from "./index";

describe("obs", () => {
  test("creates stable request ids from headers", () => {
    const envelope = createEventEnvelope(
      new Request("http://localhost/health", {
        headers: {
          "x-request-id": "req-123",
        },
      }),
      { service: "test-service" },
    );

    expect(envelope.requestId).toBe("req-123");
    expect(envelope.event.service).toBe("test-service");
  });

  test("finalizes envelopes with response metadata", () => {
    const envelope = createEventEnvelope(
      new Request("http://localhost/health"),
      { service: "test-service" },
    );

    envelope.set({
      route: {
        name: "health",
      },
    });

    const event = envelope.finish(
      new Response('{"status":"ok"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(event.status_code).toBe(200);
    expect(event.outcome).toBe("ok");
    expect((event.data.response as Record<string, unknown>).content_type).toBe("application/json");
    expect((event.data.route as Record<string, unknown>).name).toBe("health");
  });

  test("collects health reports and records failures", async () => {
    const report = await collectHealthReport({
      service: "test-service",
      startedAtMs: Date.now() - 1000,
      checks: {
        ok: () => ({ detail: "ready" }),
        bad: () => {
          throw new Error("boom");
        },
      },
    });

    expect(report.status).toBe("error");
    expect(report.checks.ok.status).toBe("ok");
    expect(report.checks.bad.status).toBe("error");
    expect(report.checks.bad.error).toBe("boom");
  });

  test("memory sink captures emitted events", () => {
    const sink = new MemorySink();
    const envelope = createEventEnvelope(new Request("http://localhost/foo"), {
      service: "test-service",
    });
    sink.emit(envelope.finish(new Response(null, { status: 204 })));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.service).toBe("test-service");
  });
});
