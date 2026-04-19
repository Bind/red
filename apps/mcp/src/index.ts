#!/usr/bin/env bun
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createMcpEndpoint } from "./mcp-server";

const config = loadConfig();
const mcp = await createMcpEndpoint();
const app = createApp({ config, mcp });

console.log(
	`mcp listening on http://0.0.0.0:${config.port} (auth=${config.disableAuth ? "DISABLED" : "oauth"})`,
);

Bun.serve({ port: config.port, fetch: app.fetch });
