import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Registers every MCP tool on the server. Boilerplate scope: a single `ping`
 * tool that proves the transport + auth + serialisation round-trip work.
 * Real tools (list_repos, get_change, etc.) land in follow-up PRs.
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Connectivity probe. Returns a timestamped pong response.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: `pong @ ${new Date().toISOString()}`,
        },
      ],
    }),
  );
}
