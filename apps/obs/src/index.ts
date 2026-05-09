#!/usr/bin/env bun
import { resolve } from "node:path";
import { configureServerLogging, getServerLogger } from "@red/server";
import { createBureauAgentProvider } from "../../../bureau/provider";
import { sandbox } from "../../../bureau/sandbox";
import { runTriageAnalyze } from "../../../bureau/workflows/triage/workflow";
import { createApp } from "./service/app";
import { replayCollectorFromRaw } from "./service/collector-service";
import {
  BureauTriageDispatcher,
  DedupingTriageDispatcher,
  type TriageDispatcher,
} from "./service/triage-dispatcher";
import { createCollectorDeps, loadConfig, type TriageConfig } from "./util/config";

await configureServerLogging({ app: "red", lowestLevel: "info" });
const config = loadConfig();
const triageDispatcher = config.triage ? buildBureauTriageDispatcher(config.triage) : undefined;
const deps = createCollectorDeps(config, { triageDispatcher });
const logger = getServerLogger(["obs"]);

function buildBureauTriageDispatcher(triageConfig: TriageConfig): TriageDispatcher {
  const sourceRoot = resolve(process.env.BUREAU_SOURCE_ROOT ?? process.cwd());
  const sandboxProvider = sandbox.justBash();
  const agentProvider = createBureauAgentProvider({
    sandboxProvider,
    repoRoot: sourceRoot,
  });
  const maxWallclockMs = Number.parseInt(
    process.env.TRIAGE_MAX_WALLCLOCK_MS ?? `${10 * 60_000}`,
    10,
  );
  const inner = new BureauTriageDispatcher({
    runAnalyze: async (rollup) => {
      await runTriageAnalyze({
        rollup,
        deps: {
          agentProvider,
          sandboxProvider,
          sourceRoot,
          maxWallclockMs,
        },
      });
    },
  });
  return new DedupingTriageDispatcher({
    inner,
    filter: { minStatusCode: triageConfig.minStatusCode },
    dedupTtlMs: triageConfig.dedupTtlMs,
  });
}

if (config.replayWindowMs > 0) {
  await replayCollectorFromRaw(deps, new Date(Date.now() - config.replayWindowMs), new Date());
}

const app = createApp(deps);

setInterval(() => {
  void app.flushExpired();
}, config.sweepIntervalMs);

logger.info("wide-events collector listening on {url}", {
  url: `http://${config.hostname}:${config.port}`,
});
logger.info("wide-events storage configured", {
  storage_backend: config.storageBackend,
  raw_events:
    config.storageBackend === "minio" ? (config.rawS3?.bucket ?? null) : config.rawEventsDir,
  rollups: config.storageBackend === "minio" ? (config.rollupS3?.bucket ?? null) : config.rollupDir,
});

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return app.fetch(request);
  },
});
