#!/usr/bin/env bun

import { configureDaemonWorkflowLogging, localReviewLogger } from "./logger";
import { runLocalDaemonReview } from "./local";

await configureDaemonWorkflowLogging();

runLocalDaemonReview().catch((error) => {
  localReviewLogger.error("local daemon review entrypoint failed", { error });
  const stack =
    error instanceof Error
      ? error.stack ?? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error, null, 2);
  process.stderr.write(`${stack}\n`);
  process.exit(1);
});
