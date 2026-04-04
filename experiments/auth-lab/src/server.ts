import { decodeJwt } from "jose";
import { AuthLabError } from "./errors";
import { createHumanAuthPolicy } from "./human-auth-policy";
import { createHumanAuthRuntime } from "./human-auth-runtime";
import { createMachineClientRegistry, type MachineClientSeed } from "./m2m/registry";
import { createTokenAuthority } from "./m2m/token-service";

export interface AuthLabServerConfig {
  issuer: string;
  audience: string;
  hostname: string;
  port: number;
  exposeTestMailbox?: boolean;
  seedClients: MachineClientSeed[];
  humanAuthSecret?: string;
  signingPrivateJwk?: string;
  database: {
    kind: "sqlite" | "postgres";
    sqlitePath?: string;
    postgresUrl?: string;
  };
}

export interface AuthLabServer {
  fetch(input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response>;
  authority: Awaited<ReturnType<typeof createTokenAuthority>>;
  registry: ReturnType<typeof createMachineClientRegistry>;
  humanRuntime: Awaited<ReturnType<typeof createHumanAuthRuntime>>;
  humanPolicy: ReturnType<typeof createHumanAuthPolicy>;
}

function appendHeaders(target: Headers, headers: HeadersInit): void {
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      target.append(key, value);
    });
    return;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      target.append(key, value);
    }
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        target.append(key, item);
      }
      continue;
    }
    target.append(key, value);
  }
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const mergedHeaders = new Headers();
  mergedHeaders.set("content-type", "application/json; charset=utf-8");
  mergedHeaders.set("cache-control", "no-store");
  appendHeaders(mergedHeaders, headers);
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: mergedHeaders,
  });
}

function oauthError(error: unknown): Response {
  if (error instanceof AuthLabError) {
    return json({ error: error.code, error_description: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return json({ error: "server_error", error_description: message }, 500);
}

function parseBasicAuth(headers: Headers): { clientId: string; clientSecret: string } | null {
  const value = headers.get("authorization");
  if (!value) return null;
  const [scheme, encoded] = value.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

async function readBodyFields(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(body).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : []
      )
    );
  }

  const formData = await request.formData();
  return Object.fromEntries(
    [...formData.entries()].flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : []
    )
  );
}

function collectScopes(scopes: string[]): string[] {
  return [...new Set(scopes.flatMap((scope) => scope.split(/\s+/).map((item) => item.trim()).filter(Boolean)))].sort();
}

function extractTokenClientId(token: string): string | null {
  try {
    const payload = decodeJwt(token);
    return typeof payload.client_id === "string" ? payload.client_id : null;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function collectSessionAmr(session: Record<string, unknown>, user: Record<string, unknown>): string[] {
  const amr = new Set<string>();
  const onboardingState = normalizeString(user.onboardingState) ?? "pending_passkey";
  const recoveryReady = normalizeBoolean(user.recoveryReady);
  const recoveryChallengePending = normalizeBoolean(user.recoveryChallengePending);
  const authAssurance = normalizeString(user.authAssurance);
  const sessionKind = normalizeString(session.sessionKind);
  const secondFactorVerified = normalizeBoolean(session.secondFactorVerified);

  if (sessionKind === "bootstrap" || onboardingState === "pending_passkey" || recoveryChallengePending) {
    amr.add("magic_link");
  }

  if (sessionKind === "recovery_challenge") {
    amr.add("magic_link");
  }

  if (authAssurance?.includes("passkey") || sessionKind === "active") {
    amr.add("passkey");
  }

  if (secondFactorVerified || recoveryReady) {
    amr.add("mfa");
  }

  if (amr.size === 0) {
    amr.add("session");
  }

  return [...amr];
}

export async function createAuthLabServer(config: AuthLabServerConfig): Promise<AuthLabServer> {
  const registry = createMachineClientRegistry(config.seedClients);
  const authority = await createTokenAuthority({
    issuer: config.issuer,
    defaultAudience: config.audience,
    registry,
    signingPrivateJwk: config.signingPrivateJwk,
  });
  const humanPolicy = createHumanAuthPolicy();
  const humanRuntime = await createHumanAuthRuntime({
    issuer: config.issuer,
    audience: config.audience,
    hostname: config.hostname,
    port: config.port,
    secret: config.humanAuthSecret ?? "redc-auth-lab-dev-secret",
    database: config.database,
  });

  const handleToken = async (request: Request) => {
    const fields = await readBodyFields(request);
    const grantType = fields.grant_type ?? fields.grantType;
    if (grantType !== "client_credentials") {
      throw new AuthLabError("unsupported_grant_type", "Only client_credentials is supported", 400);
    }

    const basic = parseBasicAuth(request.headers);
    const clientId = basic?.clientId ?? fields.client_id ?? fields.clientId;
    const clientSecret = basic?.clientSecret ?? fields.client_secret ?? fields.clientSecret;
    if (!clientId || !clientSecret) {
      throw new AuthLabError("invalid_client", "Missing client credentials", 401);
    }

    return authority.issueClientCredentialsToken({
      clientId,
      clientSecret,
      scope: fields.scope,
      audience: fields.audience ?? fields.resource ?? config.audience,
    });
  };

  const authenticateRequestClient = (request: Request, fields: Record<string, string>) => {
    const basic = parseBasicAuth(request.headers);
    const clientId = basic?.clientId ?? fields.client_id ?? fields.clientId;
    const clientSecret = basic?.clientSecret ?? fields.client_secret ?? fields.clientSecret;
    if (!clientId || !clientSecret) {
      throw new AuthLabError("invalid_client", "Missing client credentials", 401);
    }

    return registry.authenticate(clientId, clientSecret);
  };

  const handleIntrospect = async (request: Request) => {
    const fields = await readBodyFields(request);
    const token = fields.token;
    if (!token) {
      throw new AuthLabError("invalid_request", "Missing token", 400);
    }
    const requestClient = authenticateRequestClient(request, fields);
    const tokenClientId = extractTokenClientId(token);
    if (!tokenClientId) {
      throw new AuthLabError("invalid_token", "Token is missing client_id", 401);
    }
    if (tokenClientId !== requestClient.clientId) {
      throw new AuthLabError("access_denied", "Client cannot introspect another client's token", 403);
    }
    return authority.introspectToken(token);
  };

  const handleRevoke = async (request: Request) => {
    const fields = await readBodyFields(request);
    const token = fields.token;
    if (!token) {
      throw new AuthLabError("invalid_request", "Missing token", 400);
    }
    const requestClient = authenticateRequestClient(request, fields);
    const tokenClientId = extractTokenClientId(token);
    if (!tokenClientId) {
      throw new AuthLabError("invalid_token", "Token is missing client_id", 401);
    }
    if (tokenClientId !== requestClient.clientId) {
      throw new AuthLabError("access_denied", "Client cannot revoke another client's token", 403);
    }
    await authority.revokeToken(token);
    return { revoked: true };
  };

  const handleSessionExchange = async (request: Request) => {
    const sessionResult = await humanRuntime.auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    });

    if (!sessionResult.response) {
      throw new AuthLabError("invalid_session", "A valid authenticated session is required", 401);
    }

    const { session, user } = sessionResult.response as {
      session: Record<string, unknown> & {
        id: string;
        sessionKind?: string;
        authPurpose?: string;
        secondFactorVerified?: boolean;
      };
      user: Record<string, unknown> & {
        id: string;
        email: string;
        onboardingState?: string;
        recoveryReady?: boolean;
        recoveryChallengePending?: boolean;
        authAssurance?: string;
      };
    };

    const onboardingState = normalizeString(user.onboardingState) ?? "pending_passkey";
    const recoveryReady = normalizeBoolean(user.recoveryReady);
    const recoveryChallengePending = normalizeBoolean(user.recoveryChallengePending);
    const sessionKind = normalizeString(session.sessionKind);
    const secondFactorVerified = normalizeBoolean(session.secondFactorVerified);

    if (onboardingState !== "active" || !recoveryReady) {
      throw new AuthLabError("forbidden", "Active account state is required", 403);
    }
    if (recoveryChallengePending && !secondFactorVerified) {
      throw new AuthLabError(
        "forbidden",
        "Recovery challenge sessions require a second factor before exchange",
        403
      );
    }
    if (sessionKind === "bootstrap") {
      throw new AuthLabError("forbidden", "Bootstrap sessions cannot receive service JWTs", 403);
    }
    if (sessionKind === "recovery_challenge" && !secondFactorVerified) {
      throw new AuthLabError(
        "forbidden",
        "Recovery challenge sessions require a second factor before exchange",
        403
      );
    }

    const token = await authority.issueSessionExchangeToken({
      subject: `user:${user.id}`,
      sid: session.id,
      email: user.email,
      amr: collectSessionAmr(session, user),
      onboardingState,
      recoveryReady,
      scope: "session:exchange",
    });

    return json(token, 200, sessionResult.headers);
  };

  const requireAuthenticatedSession = async (request: Request) => {
    const sessionResult = await humanRuntime.auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    });
    if (!sessionResult.response) {
      throw new AuthLabError("invalid_session", "A valid authenticated session is required", 401);
    }
    return sessionResult.response as {
      session: { id: string; sessionKind?: string; secondFactorVerified?: boolean };
      user: {
        email: string;
        onboardingState?: string;
        recoveryReady?: boolean;
        recoveryChallengePending?: boolean;
        twoFactorEnabled?: boolean;
      };
    };
  };

  const requireEmail = async (request: Request): Promise<string> => {
    const fields = await readBodyFields(request);
    const email = normalizeString(fields.email);
    if (!email) {
      throw new AuthLabError("invalid_request", "email is required", 400);
    }
    return email;
  };

  return {
    authority,
    registry,
    humanRuntime,
    humanPolicy,
    async fetch(input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      try {
        if (url.pathname.startsWith("/api/auth")) {
          return await humanRuntime.auth.handler(request);
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return json({ status: "ok" });
        }

        if (config.exposeTestMailbox && request.method === "GET" && url.pathname === "/__test__/mailbox/latest") {
          const email = normalizeString(url.searchParams.get("email"));
          const mail = email
            ? humanRuntime.mailbox.filter((entry) => entry.email === email).at(-1)
            : humanRuntime.mailbox.at(-1);
          if (!mail) {
            throw new AuthLabError("not_found", "No mailbox entry found", 404);
          }
          return json(mail, 200);
        }

        if (request.method === "POST" && url.pathname === "/human/two-factor/enroll") {
          const { session, user } = await requireAuthenticatedSession(request);
          const result = await humanRuntime.enrollRecoveryFactorBySession(session.id, user.email);
          return json(result, 200);
        }

        if (request.method === "POST" && url.pathname === "/human/two-factor/verify") {
          const { session, user } = await requireAuthenticatedSession(request);
          const fields = await readBodyFields(request);
          const code = normalizeString(fields.code);
          const kind = normalizeString(fields.kind);
          if (!code) {
            throw new AuthLabError("invalid_request", "code is required", 400);
          }
          const result = await humanRuntime.verifyRecoveryFactorBySession(session.id, user.email, {
            code,
            kind: kind === "backup_code" ? "backup_code" : "totp",
          });
          return json(result, 200);
        }

        if (request.method === "POST" && url.pathname === "/human/onboarding/complete") {
          const { session, user } = await requireAuthenticatedSession(request);
          await humanRuntime.promoteAccountToActiveBySession(session.id, user.email);
          return json({ ok: true, sessionId: session.id, email: user.email });
        }

        if (request.method === "POST" && url.pathname === "/human/recovery/start") {
          const email = await requireEmail(request);
          await humanRuntime.startRecoveryChallengeByEmail(email);
          const mailRequest = new Request(`${config.issuer}/api/auth/sign-in/magic-link`, {
            method: "POST",
            headers: {
              origin: config.issuer,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email,
              metadata: {
                purpose: "recovery",
              },
            }),
          });
          return await humanRuntime.auth.handler(mailRequest);
        }

        if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
          return json(authority.jwks);
        }

        if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
          return json({
            issuer: config.issuer,
            jwks_uri: `${config.issuer}/.well-known/jwks.json`,
            token_endpoint: `${config.issuer}/oauth/token`,
            session_exchange_endpoint: `${config.issuer}/session/exchange`,
            introspection_endpoint: `${config.issuer}/oauth/introspect`,
            revocation_endpoint: `${config.issuer}/oauth/revoke`,
            grant_types_supported: ["client_credentials"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
            scopes_supported: collectScopes(registry.list().flatMap((client) => client.allowedScopes)),
          });
        }

        if (request.method === "POST" && url.pathname === "/session/exchange") {
          return await handleSessionExchange(request);
        }

        if (request.method === "POST" && url.pathname === "/oauth/token") {
          const token = await handleToken(request);
          return json(token, 200);
        }

        if (request.method === "POST" && url.pathname === "/oauth/introspect") {
          const result = await handleIntrospect(request);
          return json(result, 200);
        }

        if (request.method === "POST" && url.pathname === "/oauth/revoke") {
          const result = await handleRevoke(request);
          return json(result, 200);
        }

        return json({ error: "Not found" }, 404);
      } catch (error) {
        return oauthError(error);
      }
    },
  };
}
