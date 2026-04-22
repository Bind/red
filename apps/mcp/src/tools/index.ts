import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Registers every MCP tool on the server. Boilerplate scope: a single `ping`
 * tool that proves the transport + auth + serialisation round-trip work.
 * Real tools (list_repos, get_change, etc.) land in follow-up PRs.
 */
export function registerTools(server: McpServer): void {
	(server.registerTool as any)(
		"ping",
		{
			title: "Ping",
			description: "Connectivity probe. Echoes the received `msg` back.",
			inputSchema: { msg: z.string().default("pong") },
		},
		async ({ msg }: { msg: string }) => ({
			content: [
				{
					type: "text",
					text: `${msg} @ ${new Date().toISOString()}`,
				},
			],
		}),
	);
}
