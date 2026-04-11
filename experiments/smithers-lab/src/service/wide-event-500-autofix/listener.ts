import type { AppConfig } from "../../util/config";
import type {
  SmithersRunResponse,
  WideEvent500AutofixTrigger,
  WideEventRollupCandidate,
  WideEventTerminalQuery,
} from "../../util/types";
import { evaluateWideEvent500Trigger } from "./trigger-gate";

export interface WideEventRollupReader {
  listTerminalCandidates(query: WideEventTerminalQuery): Promise<WideEventRollupCandidate[]>;
}

export type WideEventPollResult = {
  accepted: Array<{
    requestId: string;
    fingerprint: string;
    reason: string;
    result: SmithersRunResponse;
  }>;
  skipped: Array<{
    requestId: string;
    fingerprint: string;
    reason: string;
  }>;
};

export async function pollWideEvent500Candidates(
  config: AppConfig,
  reader: WideEventRollupReader,
  query: WideEventTerminalQuery,
  runWorkflow: (
    config: AppConfig,
    input: WideEvent500AutofixTrigger,
  ) => Promise<SmithersRunResponse>,
): Promise<WideEventPollResult> {
  const candidates = await reader.listTerminalCandidates(query);

  const accepted: WideEventPollResult["accepted"] = [];
  const skipped: WideEventPollResult["skipped"] = [];

  for (const candidate of candidates) {
    const gate = evaluateWideEvent500Trigger(candidate);
    if (!gate.accepted) {
      skipped.push({
        requestId: candidate.requestId,
        fingerprint: candidate.fingerprint,
        reason: gate.reason,
      });
      continue;
    }

    const result = await runWorkflow(config, candidate);
    accepted.push({
      requestId: candidate.requestId,
      fingerprint: candidate.fingerprint,
      reason: gate.reason,
      result,
    });
  }

  return {
    accepted,
    skipped,
  };
}
