import { createApp } from "./service/app";
import { InlineShellExecutorBackend } from "./service/executor-backend";
import { LocalAttemptQueue, LocalJobsService, LocalWorker } from "./service/runner";
import { FileJobStore } from "./store/run-store";
import { loadConfig } from "./util/config";

const config = loadConfig();
const store = new FileJobStore(config.runsFile);
const queue = new LocalAttemptQueue(store);
const backend = new InlineShellExecutorBackend();
const worker = new LocalWorker("worker-default", config, store, queue, backend);
const jobs = new LocalJobsService(store, queue, worker);
const app = createApp(config, jobs);

console.log(
  JSON.stringify({
    service: "ci-runner-lab",
    mode: config.mode,
    host: config.hostname,
    port: config.port,
    stateFile: config.runsFile,
    workDir: config.workDir,
    workerId: "worker-default",
  }),
);

export default {
  port: config.port,
  hostname: config.hostname,
  fetch: app.fetch,
};
