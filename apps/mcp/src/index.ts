#!/usr/bin/env bun
import { configureServerLogging, getServerLogger } from "@red/server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createMcpEndpoint } from "./mcp-server";

await configureServerLogging({ app: "red", lowestLevel: "info" });
const config = loadConfig();
const mcp = await createMcpEndpoint();
const app = createApp({ config, mcp });
const logger = getServerLogger(["mcp"]);

logger.info("mcp listening on {url}", {
	url: `http://0.0.0.0:${config.port}`,
	auth: config.disableAuth ? "DISABLED" : "oauth",
});

Bun.serve({ port: config.port, fetch: app.fetch });
