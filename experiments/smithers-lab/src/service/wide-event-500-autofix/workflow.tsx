/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Parallel, Sequence } from "smithers-orchestrator";

import {
  wideEvent500AutofixContextSchema,
  wideEvent500AutofixDiagnosisSchema,
  wideEvent500AutofixEvidenceSchema,
  wideEvent500AutofixRepairPlanSchema,
  wideEvent500AutofixWorkflowSummarySchema,
} from "../../util/types";
import {
  createWideEventAggregatorAgent,
  createWideEventClassifierAgent,
  createWideEventContextAgent,
  createWideEventEvidenceAgent,
} from "./agents";

export function createWideEvent500AutofixWorkflow(opts: { dbPath: string; model: string }) {
  const { Workflow, Task, smithers, outputs } = createSmithers(
    {
      diagnosis: wideEvent500AutofixDiagnosisSchema,
      evidence: wideEvent500AutofixEvidenceSchema,
      context: wideEvent500AutofixContextSchema,
      repairPlan: wideEvent500AutofixRepairPlanSchema,
      workflowSummary: wideEvent500AutofixWorkflowSummarySchema,
    },
    {
      dbPath: opts.dbPath,
    },
  );

  const classifierAgent = createWideEventClassifierAgent(opts.model);
  const evidenceAgent = createWideEventEvidenceAgent(opts.model);
  const contextAgent = createWideEventContextAgent(opts.model);
  const aggregatorAgent = createWideEventAggregatorAgent(opts.model);

  return smithers((ctx) => {
    const diagnosis = ctx.outputMaybe(outputs.diagnosis, { nodeId: "classify-incident" });
    const evidence = ctx.outputMaybe(outputs.evidence, { nodeId: "collect-wide-event-evidence" });
    const incidentContext = ctx.outputMaybe(outputs.context, { nodeId: "collect-redc-context" });
    const repairPlan = ctx.outputMaybe(outputs.repairPlan, { nodeId: "aggregate-diagnosis" });

    const triggerDetails = JSON.stringify(ctx.input, null, 2);

    return (
      <Workflow name="wide-event-500-autofix">
        <Sequence>
          <Parallel>
            <Task id="classify-incident" output={outputs.diagnosis} agent={classifierAgent}>
              {`Classify this recurring root >=500 failure for redc.\n\nTrigger:\n${triggerDetails}\n\nReturn a conservative diagnosis. Treat infra or dependency issues as non-patchable. Prefer explicit ownership only when supported by the trigger payload.`}
            </Task>

            <Task id="collect-wide-event-evidence" output={outputs.evidence} agent={evidenceAgent}>
              {`Summarize the operational evidence for this wide-event-triggered failure.\n\nTrigger:\n${triggerDetails}\n\nFocus on root status, rollup reason, services touched, likely patchability, and the smallest likely owner/repo hints from the payload.`}
            </Task>

            <Task id="collect-redc-context" output={outputs.context} agent={contextAgent}>
              {`Infer the redc ownership and remediation context for this failure.\n\nTrigger:\n${triggerDetails}\n\nReturn target repo/branch/change/run hints, duplicate PR risk, and notes about ambiguity.`}
            </Task>
          </Parallel>

          {diagnosis && evidence && incidentContext ? (
            <Task id="aggregate-diagnosis" output={outputs.repairPlan} agent={aggregatorAgent}>
              {`Produce a diagnosis-first repair plan for this recurring 500.\n\nTrigger:\n${triggerDetails}\n\nDiagnosis:\n${JSON.stringify(diagnosis, null, 2)}\n\nEvidence:\n${JSON.stringify(evidence, null, 2)}\n\nContext:\n${JSON.stringify(incidentContext, null, 2)}\n\nOnly set shouldAttemptFix=true when the repo is clear, the issue looks patchable, and confidence is high enough for a bounded fix.`}
            </Task>
          ) : null}

          {diagnosis && evidence && incidentContext && repairPlan ? (
            <Task
              id="summarize-autofix-state"
              output={outputs.workflowSummary}
              agent={aggregatorAgent}
            >
              {`Summarize the current state of the wide-event 500 autofix workflow.\n\nDiagnosis:\n${JSON.stringify(diagnosis, null, 2)}\n\nEvidence:\n${JSON.stringify(evidence, null, 2)}\n\nContext:\n${JSON.stringify(incidentContext, null, 2)}\n\nRepair plan:\n${JSON.stringify(repairPlan, null, 2)}\n\nReturn a decision of diagnose_only, attempt_fix_later, or ignore. This version of the workflow does not patch code or open a PR yet.`}
            </Task>
          ) : null}
        </Sequence>
      </Workflow>
    );
  });
}
