import { Hono } from "hono";
import type { CanaryConfig, MirrorStateStore } from "../util/types";
import type { MirrorLoopService } from "./mirror-loop";

export function createApp(config: CanaryConfig, store: MirrorStateStore, loop: MirrorLoopService) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/status", (c) =>
    c.json({
      service: "git-mirror-canary",
      mode: config.mode,
      pollIntervalMs: config.pollIntervalMs,
      repos: store.listRepoStatuses(),
      recentEvents: store.listEvents(50),
      configuredRepos: config.repos.map((repo) => ({
        id: repo.id,
        trackedRef: repo.trackedRef,
        sourceUrl: repo.sourceUrl,
        targetUrl: repo.targetUrl,
        pollIntervalMs: repo.pollIntervalMs ?? config.pollIntervalMs,
      })),
    }),
  );

  app.post("/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoIds = Array.isArray(body?.repoIds)
      ? body.repoIds.filter(
          (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : undefined;
    await loop.runOnce(repoIds);
    return c.json({ queued: true, repoIds: repoIds ?? null });
  });

  return app;
}
