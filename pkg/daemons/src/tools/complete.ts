import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { CompletePayload, type CompletePayload as CompletePayloadT } from "../schema";

export const COMPLETE_TOOL_NAME = "complete";

const CompleteParams = Type.Object(
  {
    summary: Type.String({
      minLength: 1,
      description: "One-sentence recap of what this run accomplished.",
    }),
    findings: Type.Optional(
      Type.Array(
        Type.Object(
          {
            invariant: Type.String({
              pattern: "^[a-z][a-z0-9_]*$",
              description: "snake_case tag identifying the invariant reported.",
            }),
            target: Type.Optional(Type.String()),
            status: Type.Union([
              Type.Literal("ok"),
              Type.Literal("healed"),
              Type.Literal("violation_persists"),
              Type.Literal("skipped"),
            ]),
            note: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    nextRunHint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type CompleteCapture = {
  payload?: CompletePayloadT;
  error?: string;
};

export function createCompleteTool(capture: CompleteCapture): AgentTool<typeof CompleteParams> {
  return {
    name: COMPLETE_TOOL_NAME,
    label: "Complete",
    description:
      "Signal that this daemon's run is complete. Call this exactly once, at the end of your work. The run ends as soon as this tool is called.",
    parameters: CompleteParams,
    async execute(_toolCallId, params: Static<typeof CompleteParams>) {
      const parsed = CompletePayload.safeParse(params);
      if (!parsed.success) {
        capture.error = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        return {
          content: [
            {
              type: "text" as const,
              text: `complete call rejected: ${capture.error}. Fix and call complete again.`,
            },
          ],
          details: { error: capture.error },
        };
      }
      capture.payload = parsed.data;
      return {
        content: [
          {
            type: "text" as const,
            text: "complete acknowledged; run will end.",
          },
        ],
        details: parsed.data,
      };
    },
  };
}
