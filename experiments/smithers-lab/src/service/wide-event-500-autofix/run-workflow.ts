import { runWorkflow } from "smithers-orchestrator";

import { FilesystemRunStore } from "../../store/filesystem-run-store";
import type { AppConfig } from "../../util/config";
import type { SmithersRunResponse, WideEvent500AutofixTrigger } from "../../util/types";
import { createWideEvent500AutofixWorkflow } from "./workflow";

export async function runWideEvent500AutofixWorkflow(
  config: AppConfig,
  input: WideEvent500AutofixTrigger,
): Promise<SmithersRunResponse> {
  const store = new FilesystemRunStore(config.dbPath);
  store.init();

  const workflow = createWideEvent500AutofixWorkflow({
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
