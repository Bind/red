import { describeHealthContract } from "@red/health";
import { createApp } from "./app";
import { createMcpEndpoint } from "./mcp-server";

describeHealthContract({
	serviceName: "mcp",
	loadApp: async () => {
		const mcp = await createMcpEndpoint();
		return createApp({
			config: {
				port: 0,
				authBaseUrl: "http://auth.test",
				clientId: "test-client",
				clientSecret: "test-secret",
				requiredScope: "mcp:read",
				disableAuth: true,
			},
			mcp,
		});
	},
});
