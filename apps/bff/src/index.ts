import { createApp, type BffConfig } from "./app";

function loadConfig(): BffConfig {
  return {
    port: parseInt(process.env.BFF_PORT ?? "3001", 10),
    apiBaseUrl: process.env.REDC_API_BASE_URL ?? "http://localhost:3000",
    authBaseUrl: process.env.AUTH_BASE_URL ?? "http://localhost:4020",
  };
}

const config = loadConfig();
const app = createApp(config);

console.log(`BFF listening on http://0.0.0.0:${config.port}`);
console.log(`API upstream: ${config.apiBaseUrl}`);
console.log(`Auth upstream: ${config.authBaseUrl}`);

Bun.serve({
  port: config.port,
  fetch: app.fetch,
});
