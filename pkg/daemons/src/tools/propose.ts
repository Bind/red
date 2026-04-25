import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export const PROPOSE_TOOL_NAME = "propose";

const ProposeParams = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      description: "Repo-relative file path the proposed heal applies to.",
    }),
    line: Type.Integer({
      minimum: 1,
      description: "First line (1-indexed) in the file's current content to replace.",
    }),
    endLine: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Last line (1-indexed) to replace, inclusive. Defaults to `line` for single-line heals.",
      }),
    ),
    replacement: Type.String({
      description:
        "New content for the line range. Use the empty string to delete the lines. Multi-line replacements use \\n separators.",
    }),
    reason: Type.Optional(
      Type.String({
        description: "Short explanation for the heal (shown to reviewers alongside the suggestion).",
      }),
    ),
  },
  { additionalProperties: false },
);

export type Proposal = {
  file: string;
  line: number;
  endLine: number;
  replacement: string;
  reason?: string;
};

export type ProposalCapture = {
  proposals: Proposal[];
};

export function createProposeTool(capture: ProposalCapture): AgentTool<typeof ProposeParams> {
  return {
    name: PROPOSE_TOOL_NAME,
    label: "Propose",
    description:
      "Propose a heal: structured replacement of a line range in a file. Call once per heal; multiple proposals across files are allowed in a single run. The runtime collects them and surfaces them to reviewers as inline `suggestion` review comments where the lines overlap the PR's diff. The real checkout is not modified.",
    parameters: ProposeParams,
    async execute(_toolCallId, params: Static<typeof ProposeParams>) {
      const endLine = params.endLine ?? params.line;
      if (endLine < params.line) {
        return {
          content: [
            {
              type: "text" as const,
              text: `propose rejected: endLine (${endLine}) must be >= line (${params.line}).`,
            },
          ],
          details: { error: "endLine_before_line" },
        };
      }
      const proposal: Proposal = {
        file: params.file,
        line: params.line,
        endLine,
        replacement: params.replacement,
        reason: params.reason,
      };
      capture.proposals.push(proposal);
      return {
        content: [
          {
            type: "text" as const,
            text: `proposal recorded for ${params.file} lines ${params.line}-${endLine}.`,
          },
        ],
        details: proposal,
      };
    },
  };
}
