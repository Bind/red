import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type EventEnvelope, MemorySink } from "./core";
import { getEnvelope, obsMiddleware } from "./hono";

type ObsVars = { Variables: { envelope: EventEnvelope } };

describe("obsMiddleware route naming", () => {
  test("records matched route path by default", async () => {
    const sink = new MemorySink();
    const app = new Hono<ObsVars>();
    app.use("*", obsMiddleware({ service: "test", sink }));
    app.get("/foo/:id", (c) => c.json({ ok: true }));

    const response = await app.request("http://local.test/foo/123");

    expect(response.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0]?.data.route as Record<string, unknown>)?.name).toBe("foo/:id");
  });

  test("preserves explicit route names set by handlers", async () => {
    const sink = new MemorySink();
    const app = new Hono<ObsVars>();
    app.use("*", obsMiddleware({ service: "test", sink }));
    app.get("/health", (c) => {
      getEnvelope(c).set({
        route: {
          name: "health",
        },
      });
      return c.json({ ok: true });
    });

    const response = await app.request("http://local.test/health");

    expect(response.status).toBe(200);
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0]?.data.route as Record<string, unknown>)?.name).toBe("health");
  });
});
