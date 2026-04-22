#!/usr/bin/env bun
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const completeInputShape = {
  summary: z
    .string()
    .min(1)
    .describe("One-sentence recap of what the daemon run accomplished."),
  findings: z
    .array(
      z.object({
        invariant: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .describe("snake_case tag identifying the invariant being reported."),
        target: z
          .string()
          .optional()
          .describe("Optional path or id the finding applies to."),
        status: z
          .enum(["ok", "healed", "violation_persists", "skipped"])
          .describe("Outcome for this invariant/target pair."),
        note: z.string().optional().describe("Optional freeform context."),
      }),
    )
    .optional()
    .describe("Structured per-invariant findings."),
  nextRunHint: z
    .string()
    .optional()
    .describe("Optional advice for the next invocation."),
};

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "redc-daemons", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "complete",
    {
      description:
        "Signal that this daemon's run is complete. Call this exactly once, at the end of your work. The caller ends the run loop when it sees this call.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- multiple hoisted zod copies cause TS identity mismatch at this boundary; runtime is correct.
      inputSchema: completeInputShape as unknown as any,
    },
    async (args: Record<string, unknown>) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `run completed: ${JSON.stringify(args)}`,
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`mcp-server fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
