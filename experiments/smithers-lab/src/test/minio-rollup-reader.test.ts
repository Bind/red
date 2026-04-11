import { describe, expect, test } from "bun:test";

import { MinioWideEventRollupReader } from "../service/wide-event-500-autofix/minio-rollup-reader";

describe("MinioWideEventRollupReader", () => {
  test("filters to root terminal 500 rollups and computes recurrence", async () => {
    const client = {
      list: async () => ({
        contents: [{ key: "rollup/date=2026-04-09/hour=02/test.ndjson" }],
        nextContinuationToken: undefined,
      }),
      file: () => ({
        text: async () =>
          [
            JSON.stringify({
              request_id: "root-1",
              entry_service: "bff",
              services: ["bff"],
              route_names: [],
              has_terminal_event: true,
              request_state: "completed",
              final_outcome: "error",
              final_status_code: 500,
              primary_error: { name: "TypeError", message: "boom" },
              events: [
                {
                  request_id: "root-1",
                  is_request_root: true,
                  data: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
                },
              ],
              rollup_reason: "terminal_event",
              rolled_up_at: "2026-04-09T02:55:00Z",
              request: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
            }),
            JSON.stringify({
              request_id: "root-2",
              entry_service: "bff",
              services: ["bff"],
              route_names: [],
              has_terminal_event: true,
              request_state: "completed",
              final_outcome: "error",
              final_status_code: 500,
              primary_error: { name: "TypeError", message: "boom" },
              events: [
                {
                  request_id: "root-2",
                  is_request_root: true,
                  data: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
                },
              ],
              rollup_reason: "terminal_event",
              rolled_up_at: "2026-04-09T02:56:00Z",
              request: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
            }),
            JSON.stringify({
              request_id: "child-1",
              entry_service: "bff",
              services: ["bff"],
              route_names: [],
              has_terminal_event: true,
              request_state: "completed",
              final_outcome: "error",
              final_status_code: 500,
              primary_error: { name: "TypeError", message: "boom" },
              events: [
                {
                  request_id: "child-1",
                  is_request_root: false,
                  data: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
                },
              ],
              rollup_reason: "timeout",
              rolled_up_at: "2026-04-09T02:57:00Z",
              request: { request: { method: "GET", path: "/rpc/app/hosted-repo" } },
            }),
          ].join("\n"),
      }),
    };

    const reader = new MinioWideEventRollupReader(
      {
        endpoint: "http://127.0.0.1:9003",
        region: "us-east-1",
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
        bucket: "wide-events-rollup",
        prefix: "rollup",
      },
      {
        now: () => new Date("2026-04-09T03:00:00Z"),
        client: client as never,
      },
    );

    const results = await reader.listTerminalCandidates({
      since: "2026-04-09T02:45:00Z",
      services: ["bff"],
      routes: ["/rpc/app/hosted-repo"],
      requireRootRequest: true,
      requestStates: ["completed"],
      finalOutcomes: ["error"],
      minStatusCode: 500,
      requireTerminal: true,
      limit: 20,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.requestId).toBe("root-2");
    expect(results[0]?.occurrenceCount).toBe(2);
    expect(results[1]?.requestId).toBe("root-1");
    expect(results[1]?.fingerprint).toBe("bff:/rpc/app/hosted-repo:500:typeerror");
  });
});
