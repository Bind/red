/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod";

import { createResearchAgent, createWriterAgent } from "./agents";

const researchOutputSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).min(3).max(6),
  risks: z.array(z.string()).min(1).max(4),
});

const briefOutputSchema = z.object({
  title: z.string(),
  recommendation: z.string(),
  nextSteps: z.array(z.string()).min(2).max(5),
});

export function createResearchBriefWorkflow(opts: { dbPath: string; model: string }) {
  const {
    Workflow,
    Task: WorkflowTask,
    smithers,
    outputs,
  } = createSmithers(
    {
      research: researchOutputSchema,
      brief: briefOutputSchema,
    },
    {
      dbPath: opts.dbPath,
    },
  );

  const researchAgent = createResearchAgent(opts.model);
  const writerAgent = createWriterAgent(opts.model);

  return smithers((ctx) => {
    const research = ctx.outputMaybe(outputs.research, { nodeId: "research" });

    return (
      <Workflow name="research-brief">
        <Sequence>
          <WorkflowTask id="research" output={outputs.research} agent={researchAgent}>
            {`Research this topic for a ${ctx.input.audience} audience.\n\nTopic: ${ctx.input.topic}\n\nReturn a short summary, key points, and risks.`}
          </WorkflowTask>

          {research ? (
            <WorkflowTask id="brief" output={outputs.brief} agent={writerAgent}>
              {`Write a brief recommendation for ${ctx.input.audience}.\n\nTopic: ${ctx.input.topic}\nSummary: ${research.summary}\nKey points: ${research.keyPoints.join("; ")}\nRisks: ${research.risks.join("; ")}\n\nReturn a concise title, recommendation, and next steps.`}
            </WorkflowTask>
          ) : null}
        </Sequence>
      </Workflow>
    );
  });
}
