#!/usr/bin/env bun
import { createApp } from "./service/app";
import { createMinioWideEventRollupReaderFromEnv } from "./service/wide-event-500-autofix/minio-rollup-reader";
import { loadConfig } from "./util/config";

const config = loadConfig();
const wideEventRollupReader = createMinioWideEventRollupReaderFromEnv();
const app = createApp(config, {
  wideEventRollupReader: wideEventRollupReader ?? undefined,
});

console.log(`smithers-lab listening on http://${config.hostname}:${config.port}`);
console.log(`mode: ${config.mode}`);
console.log(`db: ${config.dbPath}`);
console.log(`model: ${config.openaiModel}`);
console.log(`wide-event rollup reader: ${wideEventRollupReader ? "enabled" : "disabled"}`);

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return app.fetch(request);
  },
});
