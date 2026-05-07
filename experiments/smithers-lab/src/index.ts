#!/usr/bin/env bun
import { createApp } from "./service/app";
import { createMinioWideEventRollupReaderFromEnv } from "./service/wide-event-500-autofix/minio-rollup-reader";
import { loadConfig } from "./util/config";

const config = loadConfig();
const wideEventRollupReader = createMinioWideEventRollupReaderFromEnv();
const app = createApp(config, {
  wideEventRollupReader: wideEventRollupReader ?? undefined,
});

process.stdout.write(`smithers-lab listening on http://${config.hostname}:${config.port}\n`);
process.stdout.write(`mode: ${config.mode}\n`);
process.stdout.write(`db: ${config.dbPath}\n`);
process.stdout.write(`model: ${config.openaiModel}\n`);
process.stdout.write(
  `wide-event rollup reader: ${wideEventRollupReader ? "enabled" : "disabled"}\n`,
);

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return app.fetch(request);
  },
});
