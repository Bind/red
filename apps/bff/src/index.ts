import { configureServerLogging, getServerLogger } from "@red/server";
import { createApp, type BffConfig } from "./app";

function loadConfig(): BffConfig {
  const hostedRepoId = process.env.BFF_HOSTED_REPO_ID?.trim();

  return {
    port: parseInt(process.env.BFF_PORT ?? "3001", 10),
    apiBaseUrl: process.env.RED_API_BASE_URL ?? "http://localhost:3000",
    authBaseUrl: process.env.AUTH_BASE_URL ?? "http://localhost:4020",
    obsBaseUrl: process.env.OBS_BASE_URL ?? "http://obs:4090",
    triageBaseUrl: process.env.TRIAGE_BASE_URL ?? "http://triage:7000",
    grsBaseUrl: process.env.GRS_BASE_URL ?? "http://grs:8080",
    mcpBaseUrl: process.env.MCP_BASE_URL ?? "http://mcp:3002",
    disableAuth: process.env.BFF_DISABLE_AUTH?.toLowerCase() === "true",
    hostedRepo:
      hostedRepoId
        ? {
            repoId: hostedRepoId,
            apiBaseUrl: process.env.RED_API_BASE_URL ?? "http://localhost:3000",
            readmePath: process.env.BFF_HOSTED_REPO_README_PATH ?? "README.md",
          }
        : undefined,
  };
}

await configureServerLogging({ app: "red", lowestLevel: "info" });
const config = loadConfig();
const app = createApp(config);
const logger = getServerLogger(["bff"]);

logger.info("bff listening on {url}", { url: `http://0.0.0.0:${config.port}` });
logger.info("bff upstreams configured", {
  api_upstream: config.apiBaseUrl,
  auth_upstream: config.authBaseUrl,
  grs_upstream: config.grsBaseUrl,
  mcp_upstream: config.mcpBaseUrl,
});
if (config.hostedRepo) {
  logger.info("hosted repo app configured", { repo_id: config.hostedRepo.repoId });
}

Bun.serve({
  port: config.port,
  idleTimeout: 30,
  fetch: app.fetch,
});
