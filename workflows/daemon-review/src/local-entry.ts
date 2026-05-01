#!/usr/bin/env bun

import { configureDaemonWorkflowLogging, localReviewLogger } from "./logger";
import { runLocalDaemonReview } from "./local";

await configureDaemonWorkflowLogging();

runLocalDaemonReview().catch((error) => {
  localReviewLogger.error("local daemon review entrypoint failed", { error });
  process.exit(1);
});
