import { describe, expect, test } from "bun:test";
import { RollupBroadcaster } from "../service/rollup-broadcaster";
import type { WideRollupRecord } from "../service/collector-contract";

function sampleRollup(requestId: string): WideRollupRecord {
  return {
    request_id: requestId,
    first_ts: "2026-04-20T10:00:00.000Z",
    last_ts: "2026-04-20T10:00:00.050Z",
    total_duration_ms: 50,
    entry_service: "ctl",
    services: ["ctl"],
    route_names: ["POST /api/foo"],
    has_terminal_event: true,
    request_state: "completed",
    final_outcome: "ok",
    final_status_code: 200,
    event_count: 1,
    error_count: 0,
    primary_error: null,
    request: {},
    service_map: {},
    events: [],
    rollup_reason: "terminal_event",
    rolled_up_at: "2026-04-20T10:00:00.100Z",
    rollup_version: 1,
  };
}

describe("RollupBroadcaster", () => {
  test("publishes rollups to subscribers with stable ids", async () => {
    const broadcaster = new RollupBroadcaster();
    const received: Array<{ id: string; requestId: string }> = [];
    broadcaster.subscribe((event) => {
      received.push({ id: event.id, requestId: event.rollup.request_id });
    });

    await broadcaster.publish([sampleRollup("req-1"), sampleRollup("req-2")]);

    expect(received).toEqual([
      { id: "2026-04-20T10:00:00.100Z:req-1", requestId: "req-1" },
      { id: "2026-04-20T10:00:00.100Z:req-2", requestId: "req-2" },
    ]);
  });

  test("unsubscribe removes subscriber", async () => {
    const broadcaster = new RollupBroadcaster();
    let count = 0;
    const unsubscribe = broadcaster.subscribe(() => {
      count += 1;
    });

    unsubscribe();
    await broadcaster.publish([sampleRollup("req-1")]);

    expect(count).toBe(0);
  });

  test("replay returns recent events after the requested id", async () => {
    const broadcaster = new RollupBroadcaster();

    await broadcaster.publish([
      sampleRollup("req-1"),
      sampleRollup("req-2"),
      sampleRollup("req-3"),
    ]);

    const replay = broadcaster.replay({
      afterId: "2026-04-20T10:00:00.100Z:req-1",
      limit: 10,
    });

    expect(replay.map((event) => event.rollup.request_id)).toEqual([
      "req-2",
      "req-3",
    ]);
  });

  test("replay filters by service and outcome", async () => {
    const broadcaster = new RollupBroadcaster();

    await broadcaster.publish([
      sampleRollup("req-1"),
      {
        ...sampleRollup("req-2"),
        entry_service: "auth",
        final_outcome: "error",
      },
    ]);

    const replay = broadcaster.replay({
      service: "auth",
      outcome: "error",
      limit: 10,
    });

    expect(replay.map((event) => event.rollup.request_id)).toEqual(["req-2"]);
  });
});
