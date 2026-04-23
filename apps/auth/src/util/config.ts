import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthServerConfig } from "../server";
import { generateClientSecret } from "../service/m2m/secret";

function requiredPort(value: string | undefined, label: string): number {
  const port = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return port;
}

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsv(value: string | undefined, label: string): string[] {
  const raw = requiredString(value, label);
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return items;
}

function parseOptionalCsv(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSingleCsvValue(value: string | undefined, label: string): string {
  const items = parseCsv(value, label);
  if (items.length !== 1) {
    throw new Error(`${label} currently requires exactly one value`);
  }
  return items[0];
}

function parseWebClients(value: string | undefined) {
  return requiredString(value, "AUTH_LAB_WEB_CLIENTS")
    .split(",")
    .map((entry) => {
      const [clientId, redirectBaseUrl] = entry.split("=", 2).map((item) => item?.trim() ?? "");
      if (!clientId || !redirectBaseUrl) {
        throw new Error("AUTH_LAB_WEB_CLIENTS entries must use clientId=https://base-url form");
      }
      return {
        clientId,
        redirectBaseUrl,
        magicLinkPath: "/auth/magic-link",
      };
    });
}

function readRequiredFile(pathValue: string | undefined, label: string): string {
  const path = requiredString(pathValue, label);
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be read: ${message}`);
  }
}

function readRequiredSecretValue(
  inlineValue: string | undefined,
  _inlineLabel: string,
  fileValue: string | undefined,
  fileLabel: string,
): string {
  const inline = optionalString(inlineValue);
  if (inline) {
    return inline;
  }
  return readRequiredFile(fileValue, fileLabel);
}

function parseList(value: string | undefined, label: string): string[] {
  const items = requiredString(value, label)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return items;
}

function requiredPositiveInt(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(requiredString(value, label), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requiredBoolean(value: string | undefined, label: string): boolean {
  const normalized = requiredString(value, label).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function loadDevConfig(env: NodeJS.ProcessEnv): AuthRuntimeConfig {
  const port = Number.parseInt(env.AUTH_LAB_PORT ?? "4020", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`AUTH_LAB_PORT must be a positive integer`);
  }
  const hostname = env.AUTH_LAB_HOST ?? "127.0.0.1";
  const issuer = env.AUTH_LAB_ISSUER ?? `http://${hostname}:${port}`;
  const audience = env.AUTH_LAB_AUDIENCE ?? "redc-api";
  const clientId = env.AUTH_LAB_BOOTSTRAP_CLIENT_ID ?? "claw-runner-dev";
  const bootstrapClientSecret = env.AUTH_LAB_BOOTSTRAP_CLIENT_SECRET ?? generateClientSecret();
  const scopes = (env.AUTH_LAB_BOOTSTRAP_SCOPES ?? "prs:create changes:read")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const audiences = (env.AUTH_LAB_BOOTSTRAP_AUDIENCES ?? audience)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    issuer,
    audience,
    hostname,
    port,
    exposeTestMailbox: env.AUTH_LAB_EXPOSE_TEST_MAILBOX === "true",
    webClients: parseWebClients(env.AUTH_LAB_WEB_CLIENTS),
    passkeyOrigins: parseCsv(env.AUTH_LAB_PASSKEY_ORIGINS, "AUTH_LAB_PASSKEY_ORIGINS"),
    passkeyRpId: parseSingleCsvValue(env.AUTH_LAB_PASSKEY_RP_IDS, "AUTH_LAB_PASSKEY_RP_IDS"),
    stealthTotpEmails: parseOptionalCsv(
      env.AUTH_LAB_STEALTH_TOTP_EMAILS ?? "douglasjbinder@gmail.com",
    ),
    allowAnyTotpCode: env.AUTH_LAB_ALLOW_ANY_TOTP_CODE === "true",
    database: {
      kind: "sqlite",
      sqlitePath: env.AUTH_LAB_DB_PATH ?? join(tmpdir(), "redc-auth-lab.sqlite"),
    },
    userAuthSecret: env.AUTH_LAB_BETTER_AUTH_SECRET ?? "redc-auth-lab-dev-secret",
    signingPrivateJwk: optionalString(env.AUTH_LAB_SIGNING_PRIVATE_JWK),
    seedClients: [
      {
        clientId,
        clientSecret: bootstrapClientSecret,
        allowedScopes: scopes,
        allowedAudiences: audiences,
        tokenTtlSeconds: Number.parseInt(env.AUTH_LAB_BOOTSTRAP_TTL_SECONDS ?? "300", 10),
        status: "active",
        allowedGrantTypes: ["client_credentials"],
      },
    ],
    bootstrapClientSecret,
  };
}

function loadComposeConfig(env: NodeJS.ProcessEnv): AuthRuntimeConfig {
  const port = requiredPort(env.AUTH_LAB_PORT, "AUTH_LAB_PORT");
  const hostname = requiredString(env.AUTH_LAB_HOST, "AUTH_LAB_HOST");
  const issuer = requiredString(env.AUTH_LAB_ISSUER, "AUTH_LAB_ISSUER");
  const audience = requiredString(env.AUTH_LAB_AUDIENCE, "AUTH_LAB_AUDIENCE");
  const clientId = requiredString(env.AUTH_LAB_BOOTSTRAP_CLIENT_ID, "AUTH_LAB_BOOTSTRAP_CLIENT_ID");
  const bootstrapClientSecret = requiredString(
    env.AUTH_LAB_BOOTSTRAP_CLIENT_SECRET,
    "AUTH_LAB_BOOTSTRAP_CLIENT_SECRET",
  );
  const scopes = parseList(env.AUTH_LAB_BOOTSTRAP_SCOPES, "AUTH_LAB_BOOTSTRAP_SCOPES");
  const audiences = parseList(env.AUTH_LAB_BOOTSTRAP_AUDIENCES, "AUTH_LAB_BOOTSTRAP_AUDIENCES");
  const databaseUrl = requiredString(env.AUTH_LAB_DB_URL, "AUTH_LAB_DB_URL");
  const userAuthSecret = requiredString(
    env.AUTH_LAB_BETTER_AUTH_SECRET,
    "AUTH_LAB_BETTER_AUTH_SECRET",
  );
  const signingPrivateJwk = readRequiredSecretValue(
    env.AUTH_LAB_SIGNING_PRIVATE_JWK,
    "AUTH_LAB_SIGNING_PRIVATE_JWK",
    env.AUTH_LAB_SIGNING_PRIVATE_JWK_FILE,
    "AUTH_LAB_SIGNING_PRIVATE_JWK_FILE",
  );
  const bootstrapTtlSeconds = requiredPositiveInt(
    env.AUTH_LAB_BOOTSTRAP_TTL_SECONDS,
    "AUTH_LAB_BOOTSTRAP_TTL_SECONDS",
  );

  return {
    issuer,
    audience,
    hostname,
    port,
    exposeTestMailbox: requiredBoolean(
      env.AUTH_LAB_EXPOSE_TEST_MAILBOX,
      "AUTH_LAB_EXPOSE_TEST_MAILBOX",
    ),
    webClients: parseWebClients(env.AUTH_LAB_WEB_CLIENTS),
    passkeyOrigins: parseCsv(env.AUTH_LAB_PASSKEY_ORIGINS, "AUTH_LAB_PASSKEY_ORIGINS"),
    passkeyRpId: parseSingleCsvValue(env.AUTH_LAB_PASSKEY_RP_IDS, "AUTH_LAB_PASSKEY_RP_IDS"),
    stealthTotpEmails: parseOptionalCsv(
      env.AUTH_LAB_STEALTH_TOTP_EMAILS ?? "douglasjbinder@gmail.com",
    ),
    allowAnyTotpCode: requiredBoolean(
      env.AUTH_LAB_ALLOW_ANY_TOTP_CODE,
      "AUTH_LAB_ALLOW_ANY_TOTP_CODE",
    ),
    database: {
      kind: "postgres",
      postgresUrl: databaseUrl,
    },
    userAuthSecret,
    signingPrivateJwk,
    seedClients: [
      {
        clientId,
        clientSecret: bootstrapClientSecret,
        allowedScopes: scopes,
        allowedAudiences: audiences,
        tokenTtlSeconds: bootstrapTtlSeconds,
        status: "active",
        allowedGrantTypes: ["client_credentials"],
      },
    ],
    bootstrapClientSecret,
  };
}

export interface AuthRuntimeConfig extends AuthServerConfig {
  bootstrapClientSecret: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthRuntimeConfig {
  if (env.AUTH_LAB_DB_URL) {
    return loadComposeConfig(env);
  }
  return loadDevConfig(env);
}
