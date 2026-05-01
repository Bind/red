export interface McpConfig {
	port: number;
	authBaseUrl: string;
	clientId: string;
	clientSecret: string;
	/** Required OAuth scope on inbound bearer tokens, e.g. "mcp:read". */
	requiredScope: string;
	/** Disable auth entirely — dev-only. Off by default. */
	disableAuth: boolean;
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
	const port = Number.parseInt(env.MCP_PORT ?? "3002", 10);
	const disableAuth = env.MCP_DISABLE_AUTH?.toLowerCase() === "true";
	if (disableAuth) {
		return {
			port,
			authBaseUrl: env.MCP_AUTH_BASE_URL ?? "http://auth:4020",
			clientId: env.MCP_OAUTH_CLIENT_ID ?? "",
			clientSecret: env.MCP_OAUTH_CLIENT_SECRET ?? "",
			requiredScope: env.MCP_REQUIRED_SCOPE ?? "mcp:read",
			disableAuth: true,
		};
	}
	return {
		port,
		authBaseUrl: requiredEnv("MCP_AUTH_BASE_URL"),
		clientId: requiredEnv("MCP_OAUTH_CLIENT_ID"),
		clientSecret: requiredEnv("MCP_OAUTH_CLIENT_SECRET"),
		requiredScope: env.MCP_REQUIRED_SCOPE ?? "mcp:read",
		disableAuth: false,
	};
}
