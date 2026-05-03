import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export const ROUTE_DECISION_TOOL_NAME = "route_decision";

const RouteDecisionParams = Type.Object(
  {
    selected_daemons: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
    rationale: Type.String({ minLength: 1, maxLength: 4000 }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export type RouteDecisionCapture = {
  payload?: {
    selected_daemons: string[];
    rationale: string;
    confidence?: number;
  };
};

export function createRouteDecisionTool(
  capture: RouteDecisionCapture,
): AgentTool<typeof RouteDecisionParams> {
  return {
    name: ROUTE_DECISION_TOOL_NAME,
    label: "Route Decision",
    description:
      "Submit the structured daemon routing decision for this file. Call this once before complete.",
    parameters: RouteDecisionParams,
    async execute(_toolCallId, params: Static<typeof RouteDecisionParams>) {
      capture.payload = {
        selected_daemons: [...new Set(params.selected_daemons)].sort((a, b) => a.localeCompare(b)),
        rationale: params.rationale,
        confidence: params.confidence,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: "route decision captured",
          },
        ],
        details: capture.payload,
      };
    },
  };
}
