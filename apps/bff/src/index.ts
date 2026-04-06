import { createApp, type BffConfig } from "./app";

function loadConfig(): BffConfig {
  const hostedRepoId = process.env.BFF_HOSTED_REPO_ID?.trim();

  return {
    port: parseInt(process.env.BFF_PORT ?? "3001", 10),
    apiBaseUrl: process.env.REDC_API_BASE_URL ?? "http://localhost:3000",
    authBaseUrl: process.env.AUTH_BASE_URL ?? "http://localhost:4020",
    hostedRepo:
      hostedRepoId
        ? {
            repoId: hostedRepoId,
            apiBaseUrl: process.env.REDC_API_BASE_URL ?? "http://localhost:3000",
            readmePath: process.env.BFF_HOSTED_REPO_README_PATH ?? "README.md",
          }
        : undefined,
  };
}

const config = loadConfig();
const app = createApp(config);

console.log(`BFF listening on http://0.0.0.0:${config.port}`);
console.log(`API upstream: ${config.apiBaseUrl}`);
console.log(`Auth upstream: ${config.authBaseUrl}`);
if (config.hostedRepo) {
  console.log(`Hosted repo app: ${config.hostedRepo.repoId}`);
}

Bun.serve({
  port: config.port,
  fetch: app.fetch,
});
