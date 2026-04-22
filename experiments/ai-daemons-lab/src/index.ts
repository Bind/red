#!/usr/bin/env bun
import { createPRHealthDaemon } from "./daemons/pr-health";
import { createStaleIssueDaemon } from "./daemons/stale-issue";
import { maybeOpenAIHealerFromEnv } from "./healers/openai";
import { StubHealer } from "./healers/stub";
import { DaemonKernel } from "./kernel";
import { createStdoutSink } from "./wide-events";
import { ChangeStore, seedDemoChanges } from "./world/change-store";
import { IssueStore, seedDemoIssues } from "./world/issue-store";

function readInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const emit = createStdoutSink();
  const changeStore = new ChangeStore();
  const issueStore = new IssueStore();
  const now = new Date();
  seedDemoChanges(changeStore);
  seedDemoIssues(issueStore, now);

  const healer = maybeOpenAIHealerFromEnv() ?? new StubHealer();
  emit({
    kind: "ai-daemons.boot",
    route_name: "kernel",
    data: { healer: healer.name, pid: process.pid },
  });

  const kernel = new DaemonKernel({ emit });
  kernel.register(
    createPRHealthDaemon({
      store: changeStore,
      healer,
      intervalMs: readInt("AI_DAEMONS_PR_TICK_MS", 2_000),
    }),
  );
  kernel.register(
    createStaleIssueDaemon({
      store: issueStore,
      intervalMs: readInt("AI_DAEMONS_ISSUE_TICK_MS", 5_000),
    }),
  );

  const driftMs = readInt("AI_DAEMONS_DRIFT_MS", 3_000);
  const drift = setInterval(() => {
    const changes = changeStore.list();
    if (changes.length === 0) return;
    const target = changes[Math.floor(Math.random() * changes.length)];
    if (!target) return;
    const newSha = Math.random().toString(16).slice(2, 9);
    changeStore.advanceCommit(target.id, newSha);
    emit({
      kind: "world.drift",
      route_name: "world",
      data: { changeId: target.id, newSha },
    });
  }, driftMs);

  const durationSec = readInt("AI_DAEMONS_RUN_SECONDS", 30);
  const shutdown = (reason: string): void => {
    emit({ kind: "ai-daemons.shutdown", route_name: "kernel", data: { reason } });
    clearInterval(drift);
    kernel.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  kernel.start();
  setTimeout(() => shutdown("timeout"), durationSec * 1_000);
}

void main();
