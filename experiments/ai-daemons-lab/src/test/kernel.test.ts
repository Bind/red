import { describe, expect, test } from "bun:test";
import type { Daemon } from "../daemon";
import { DaemonKernel } from "../kernel";
import { createInMemoryRecorder } from "../wide-events";

function makeCountingDaemon(name: string, intervalMs: number): Daemon & { calls: number } {
  const daemon = {
    name,
    intervalMs,
    calls: 0,
    async tick() {
      daemon.calls += 1;
      return { checked: 1, healed: 0, errors: 0 };
    },
  };
  return daemon;
}

describe("DaemonKernel", () => {
  test("register + tickOnce invokes the daemon and emits completed event", async () => {
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    const d = makeCountingDaemon("probe", 1_000);
    kernel.register(d);

    const result = await kernel.tickOnce("probe");
    expect(result.checked).toBe(1);
    expect(d.calls).toBe(1);

    const kinds = rec.drain().map((e) => e.kind);
    expect(kinds).toContain("daemon.tick.completed");
  });

  test("duplicate registration throws", () => {
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    const d = makeCountingDaemon("dup", 1_000);
    kernel.register(d);
    expect(() => kernel.register(d)).toThrow();
  });

  test("tick errors are caught and reported as daemon.tick.failed", async () => {
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register({
      name: "boom",
      intervalMs: 1_000,
      async tick() {
        throw new Error("nope");
      },
    });

    const result = await kernel.tickOnce("boom");
    expect(result.errors).toBe(1);
    const events = rec.drain();
    const failed = events.find((e) => e.kind === "daemon.tick.failed");
    expect(failed?.data.error).toBe("nope");
  });

  test("start/stop emits lifecycle events", () => {
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register(makeCountingDaemon("life", 10_000));
    kernel.start();
    kernel.stop();
    const kinds = rec.drain().map((e) => e.kind);
    expect(kinds).toContain("daemon.started");
    expect(kinds).toContain("daemon.stopped");
  });
});
