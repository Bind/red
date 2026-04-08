import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNdjsonSink, HttpBatchSink, toCollectorWideEvent } from "./collector";
import type { ObsEvent } from "./core";

function event(overrides: Partial<ObsEvent> = {}): ObsEvent {
  return {
    id: overrides.id ?? "evt-1",
    type: overrides.type ?? "request.completed",
    service: overrides.service ?? "api",
    request_id: overrides.request_id ?? "req-1",
    started_at: overrides.started_at ?? "2026-04-08T10:00:00.000Z",
    ended_at: overrides.ended_at ?? "2026-04-08T10:00:00.050Z",
    duration_ms: overrides.duration_ms ?? 50,
    outcome: overrides.outcome ?? "error",
    status_code: overrides.status_code ?? 500,
    data: overrides.data ?? {
      route: { name: "session_exchange" },
      error: { name: "AuthError", message: "boom" },
    },
  };
}

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("collector mapping", () => {
  test("maps obs events into collector payload shape", () => {
    const mapped = toCollectorWideEvent(event(), {
      instanceId: "api-1",
    });

    expect(mapped).toEqual({
      event_id: "evt-1",
      request_id: "req-1",
      service: "api",
      instance_id: "api-1",
      kind: "request.completed",
      ts: "2026-04-08T10:00:00.000Z",
      ended_at: "2026-04-08T10:00:00.050Z",
      duration_ms: 50,
      outcome: "error",
      status_code: 500,
      route_name: "session_exchange",
      error_name: "AuthError",
      error_message: "boom",
      data: {
        route: { name: "session_exchange" },
        error: { name: "AuthError", message: "boom" },
      },
    });
  });
});

describe("FileNdjsonSink", () => {
  test("writes one mapped event per line", () => {
    tempDir = mkdtempSync(join(tmpdir(), "wide-events-lab-"));
    const filePath = join(tempDir, "events.ndjson");
    const sink = new FileNdjsonSink({ filePath, instanceId: "api-1" });

    sink.emit(event());

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event_id: "evt-1",
      request_id: "req-1",
      instance_id: "api-1",
    });
  });
});

describe("HttpBatchSink", () => {
  test("posts accepted batches to the collector", async () => {
    const requests: RequestInit[] = [];
    const sink = new HttpBatchSink({
      endpoint: "http://collector.local/v1/events",
      source: { service: "api", instance_id: "api-1" },
      maxBatchSize: 2,
      flushIntervalMs: 10000,
      fetchImpl: async (_url, init) => {
        requests.push(init ?? {});
        return new Response(
          JSON.stringify({
            accepted: 2,
            rejected: 0,
            request_ids: ["req-1", "req-2"],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    sink.emit(event({ request_id: "req-1", id: "evt-1" }));
    sink.emit(event({ request_id: "req-2", id: "evt-2" }));
    await sink.flush();

    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]?.body)) as {
      source: { service: string; instance_id: string };
      events: Array<Record<string, unknown>>;
    };
    expect(body.source).toEqual({ service: "api", instance_id: "api-1" });
    expect(body.events).toMatchObject([
      { event_id: "evt-1", request_id: "req-1" },
      { event_id: "evt-2", request_id: "req-2" },
    ]);
  });
});
