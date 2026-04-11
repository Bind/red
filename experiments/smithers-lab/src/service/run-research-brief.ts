import { runWorkflow } from "smithers-orchestrator";

import { FilesystemRunStore } from "../store/filesystem-run-store";
import type { AppConfig } from "../util/config";
import type { RunResearchBriefRequest, SmithersRunResponse } from "../util/types";
import { createResearchBriefWorkflow } from "./workflow";

export async function runResearchBrief(
  config: AppConfig,
  input: RunResearchBriefRequest,
): Promise<SmithersRunResponse> {
  const store = new FilesystemRunStore(config.dbPath);
  store.init();

  const workflow = createResearchBriefWorkflow({
    dbPath: store.getDbPath(),
    model: config.openaiModel,
  });

  const result = await runWorkflow(workflow, {
    input,
    rootDir: process.cwd(),
    allowNetwork: config.allowNetwork,
  });

  return {
    runId: result.runId,
    status: result.status,
    output: "output" in result ? result.output : undefined,
    error: "error" in result ? result.error : undefined,
  };
}
