#!/usr/bin/env bun
import { createApp } from "./service/app";
import { replayCollectorFromRaw } from "./service/collector-service";
import { createCollectorDeps, loadConfig } from "./util/config";

const config = loadConfig();
const deps = createCollectorDeps(config);

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

console.log(
	`wide-events collector listening on http://${config.hostname}:${config.port}`,
);
console.log(`storage backend: ${config.storageBackend}`);
console.log(
	`raw events: ${config.storageBackend === "minio" ? config.rawS3?.bucket : config.rawEventsDir}`,
);
console.log(
	`rollups: ${config.storageBackend === "minio" ? config.rollupS3?.bucket : config.rollupDir}`,
);

Bun.serve({
	hostname: config.hostname,
	port: config.port,
	fetch(request) {
		return app.fetch(request);
	},
});
