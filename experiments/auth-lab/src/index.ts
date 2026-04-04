#!/usr/bin/env bun
import { createAuthServer } from "./server";
import { loadAuthConfig } from "./util/config";

const config = loadAuthConfig();
const server = await createAuthServer(config);

console.log(`Auth lab listening on http://${config.hostname}:${config.port}`);
console.log(`Issuer: ${config.issuer}`);
console.log(
  `User auth DB: ${config.database.kind === "postgres" ? config.database.postgresUrl : config.database.sqlitePath}`,
);
console.log(`JWKS: ${config.issuer}/.well-known/jwks.json`);
console.log(`Session exchange: ${config.issuer}/session/exchange`);
console.log(`Dev client_id: ${config.seedClients[0].clientId}`);
console.log("Compose mode requires explicit env vars and a signing key file.");

Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch(request) {
    return server.fetch(request);
  },
});
