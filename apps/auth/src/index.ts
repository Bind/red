#!/usr/bin/env bun
import { configureServerLogging, getServerLogger } from "@red/server";
import { createAuthServer } from "./server";
import { loadAuthConfig } from "./util/config";

await configureServerLogging({ app: "red", lowestLevel: "info" });
const config = loadAuthConfig();
const server = await createAuthServer(config);
const logger = getServerLogger(["auth"]);

logger.info("auth lab listening on {url}", {
  url: `http://${config.hostname}:${config.port}`,
});
logger.info("auth configuration", {
  issuer: config.issuer,
  user_auth_db:
    config.database.kind === "postgres" ? config.database.postgresUrl : config.database.sqlitePath,
  jwks: `${config.issuer}/.well-known/jwks.json`,
  session_exchange: `${config.issuer}/session/exchange`,
  dev_client_id: config.seedClients[0]?.clientId ?? null,
});

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return server.fetch(request);
  },
});
