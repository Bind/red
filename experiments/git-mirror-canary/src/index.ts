#!/usr/bin/env bun
import { createApp } from "./service/app";
import { ShellMirrorGitClient } from "./service/git-client";
import { MirrorLoopService } from "./service/mirror-loop";
import { NoopMirrorEventPublisher, WebhookMirrorEventPublisher } from "./service/webhook-publisher";
import { SqliteMirrorStateStore } from "./store/state-store";
import { loadConfig } from "./util/config";

const config = loadConfig();
const store = new SqliteMirrorStateStore(config.stateDbPath);
store.init();

const publisher = config.eventWebhookUrl
  ? new WebhookMirrorEventPublisher(config.eventWebhookUrl)
  : new NoopMirrorEventPublisher();
const loop = new MirrorLoopService(config, store, new ShellMirrorGitClient(), publisher);
const app = createApp(config, store, loop);

loop.start();

console.log(`git mirror canary listening on http://${config.hostname}:${config.port}`);
console.log(`mode: ${config.mode}`);
console.log(`repos: ${config.repos.map((repo) => repo.id).join(", ")}`);
if (config.eventWebhookUrl) {
  console.log(`webhook: ${config.eventWebhookUrl}`);
}

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return app.fetch(request);
  },
});
