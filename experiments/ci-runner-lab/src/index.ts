import { createApp } from "./service/app";
import { LocalRunnerService } from "./service/runner";
import { FileRunStore } from "./store/run-store";
import { loadConfig } from "./util/config";

const config = loadConfig();
const store = new FileRunStore(config.runsFile);
const runner = new LocalRunnerService(config, store);
const app = createApp(config, runner);

console.log(
  JSON.stringify({
    service: "ci-runner-lab",
    mode: config.mode,
    host: config.hostname,
    port: config.port,
    runsFile: config.runsFile,
    workDir: config.workDir,
    maxConcurrentRuns: config.maxConcurrentRuns,
  }),
);

export default {
  port: config.port,
  hostname: config.hostname,
  fetch: app.fetch,
};
