#!/usr/bin/env bun
import { createJwksAuthServer, loadConfig } from "./jwks-server";

const config = loadConfig();
const server = await createJwksAuthServer(config);

console.log(`JWKS auth lab listening on http://${config.hostname}:${config.port}`);
console.log(`Issuer: ${config.issuer}`);
console.log(`JWKS: ${config.issuer}/.well-known/jwks.json`);

Bun.serve({
  port: config.port,
  hostname: config.hostname,
  fetch: server.fetch,
});
