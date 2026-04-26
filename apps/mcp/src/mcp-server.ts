import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools";

export interface McpEndpoint {
	handle(request: Request): Promise<Response>;
}

/**
 * Builds an MCP server in stateless mode — no session IDs, no in-process
 * connection state. Each POST /mcp is a self-contained JSON-RPC request.
 * Stateful mode (with SSE streaming) will come later if a tool actually
 * needs long-lived server-initiated notifications.
 */
export async function createMcpEndpoint(): Promise<McpEndpoint> {
	const server = new McpServer({ name: "red-mcp", version: "0.1.0" });
	registerTools(server);

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	await server.connect(transport);

	return {
		handle: (request) => transport.handleRequest(request),
	};
}
