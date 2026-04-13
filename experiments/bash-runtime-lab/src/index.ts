import { mkdir } from "node:fs/promises";
import { createApp } from "./service/app";
import { BashRuntimeService } from "./service/runtime";
import { FilesystemRunStore } from "./store/filesystem-run-store";
import { loadConfig } from "./util/config";

const config = loadConfig();

await mkdir(config.runsDir, { recursive: true });
await mkdir(config.workspacesDir, { recursive: true });

const store = new FilesystemRunStore(config.runsDir);
const runtime = new BashRuntimeService(config, store);
const app = createApp(config, runtime);

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
