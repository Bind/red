#!/usr/bin/env bun
import { configureServerLogging, getServerLogger } from "@red/server";
import { createApp } from "./service/app";
import { replayCollectorFromRaw } from "./service/collector-service";
import { createCollectorDeps, loadConfig } from "./util/config";

await configureServerLogging({ app: "red", lowestLevel: "info" });
const config = loadConfig();
const deps = createCollectorDeps(config);
const logger = getServerLogger(["obs"]);

if (config.replayWindowMs > 0) {
	await replayCollectorFromRaw(
		deps,
		new Date(Date.now() - config.replayWindowMs),
		new Date(),
	);
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
		config.storageBackend === "minio" ? config.rawS3?.bucket ?? null : config.rawEventsDir,
	rollups:
		config.storageBackend === "minio" ? config.rollupS3?.bucket ?? null : config.rollupDir,
});

Bun.serve({
	hostname: config.hostname,
	port: config.port,
	fetch(request) {
		return app.fetch(request);
	},
});
