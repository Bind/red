#!/usr/bin/env bun

import { configureDaemonWorkflowLogging, reviewLogger } from "./logger";
import { runDaemonReviewFromEnv } from "./runner";

await configureDaemonWorkflowLogging();

runDaemonReviewFromEnv().catch((error) => {
  reviewLogger.error("daemon review entrypoint failed", { error });
  process.exit(1);
});
