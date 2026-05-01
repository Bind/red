import { configureServerLogging, getServerLogger } from "../../../pkg/server/src/index";

export async function configureDaemonWorkflowLogging(): Promise<void> {
  await configureServerLogging({ app: "red", lowestLevel: "info" });
}

export const reviewLogger = getServerLogger(["daemon-review"]);
export const localReviewLogger = getServerLogger(["daemon-review", "local"]);
export const playgroundLogger = getServerLogger(["daemon-playground"]);
