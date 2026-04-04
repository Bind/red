import { Hono } from "hono";
import { decodeJwt } from "jose";
import { createBetterAuthAdapter } from "./service/better-auth-adapter";
import { createMachineClientRegistry, type MachineClientSeed } from "./service/m2m/registry";
import { createTokenAuthority } from "./service/m2m/service";
import { createSessionExchangeService } from "./service/session-exchange-service";
import { createUserAuthRuntime } from "./service/user-auth-runtime";
import { createUserLifecycleService } from "./service/user-lifecycle";
import { AuthError } from "./util/errors";

export interface AuthServerConfig {
  issuer: string;
  audience: string;
  hostname: string;
  port: number;
  exposeTestMailbox?: boolean;
  seedClients: MachineClientSeed[];
  userAuthSecret?: string;
  signingPrivateJwk?: string;
  database: {
    kind: "sqlite" | "postgres";
    sqlitePath?: string;
    postgresUrl?: string;
  };
}

export interface AuthServer {
  fetch(input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response>;
  authority: Awaited<ReturnType<typeof createTokenAuthority>>;
  registry: ReturnType<typeof createMachineClientRegistry>;
  userRuntime: Awaited<ReturnType<typeof createUserAuthRuntime>>;
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
        typeof value === "string" ? [[key, value]] : [],
      ),
    );
  }

  const formData = await request.formData();
  return Object.fromEntries(
    [...formData.entries()].flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function collectScopes(scopes: string[]): string[] {
  return [
    ...new Set(
      scopes.flatMap((scope) => scope.split(/\s+/).map((item) => item.trim())).filter(Boolean),
    ),
  ].sort();
}

function extractTokenClientId(token: string): string | null {
  try {
    const payload = decodeJwt(token);
    return typeof payload.client_id === "string" ? payload.client_id : null;
  } catch {
    return null;
  }
}

function oauthError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AuthError) {
    return {
      status: error.status,
      body: { error: error.code, error_description: error.message },
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    status: 500,
    body: { error: "server_error", error_description: message },
  };
}

export async function createAuthServer(config: AuthServerConfig): Promise<AuthServer> {
  const registry = createMachineClientRegistry(config.seedClients);
  const authority = await createTokenAuthority({
    issuer: config.issuer,
    defaultAudience: config.audience,
    registry,
    signingPrivateJwk: config.signingPrivateJwk,
  });
  const userRuntime = await createUserAuthRuntime({
    issuer: config.issuer,
    audience: config.audience,
    hostname: config.hostname,
    port: config.port,
    secret: config.userAuthSecret ?? "redc-auth-lab-dev-secret",
    database: config.database,
  });
  const authAdapter = createBetterAuthAdapter(userRuntime.auth);
  const userLifecycle = createUserLifecycleService(
    userRuntime.stores,
    config.userAuthSecret ?? "redc-auth-lab-dev-secret",
  );
  const sessionExchange = createSessionExchangeService(authAdapter, authority);
  const app = new Hono();

  const handleToken = async (request: Request) => {
    const fields = await readBodyFields(request);
    const grantType = fields.grant_type ?? fields.grantType;
    if (grantType !== "client_credentials") {
      throw new AuthError("unsupported_grant_type", "Only client_credentials is supported", 400);
    }

    const basic = parseBasicAuth(request.headers);
    const clientId = basic?.clientId ?? fields.client_id ?? fields.clientId;
    const clientSecret = basic?.clientSecret ?? fields.client_secret ?? fields.clientSecret;
    if (!clientId || !clientSecret) {
      throw new AuthError("invalid_client", "Missing client credentials", 401);
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
      throw new AuthError("invalid_client", "Missing client credentials", 401);
    }

    return registry.authenticate(clientId, clientSecret);
  };

  const handleIntrospect = async (request: Request) => {
    const fields = await readBodyFields(request);
    const token = fields.token;
    if (!token) {
      throw new AuthError("invalid_request", "Missing token", 400);
    }
    const requestClient = authenticateRequestClient(request, fields);
    const tokenClientId = extractTokenClientId(token);
    if (!tokenClientId) {
      throw new AuthError("invalid_token", "Token is missing client_id", 401);
    }
    if (tokenClientId !== requestClient.clientId) {
      throw new AuthError("access_denied", "Client cannot introspect another client's token", 403);
    }
    return authority.introspectToken(token);
  };

  const handleRevoke = async (request: Request) => {
    const fields = await readBodyFields(request);
    const token = fields.token;
    if (!token) {
      throw new AuthError("invalid_request", "Missing token", 400);
    }
    const requestClient = authenticateRequestClient(request, fields);
    const tokenClientId = extractTokenClientId(token);
    if (!tokenClientId) {
      throw new AuthError("invalid_token", "Token is missing client_id", 401);
    }
    if (tokenClientId !== requestClient.clientId) {
      throw new AuthError("access_denied", "Client cannot revoke another client's token", 403);
    }
    await authority.revokeToken(token);
    return { revoked: true };
  };

  app.onError((error, c) => {
    const { status, body } = oauthError(error);
    return c.json(body, status as 200 | 400 | 401 | 403 | 404 | 500);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.all("/api/auth/*", async (c) => authAdapter.handle(c.req.raw));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/.well-known/jwks.json", (c) => c.json(authority.jwks));

  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: config.issuer,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      token_endpoint: `${config.issuer}/oauth/token`,
      session_exchange_endpoint: `${config.issuer}/session/exchange`,
      introspection_endpoint: `${config.issuer}/oauth/introspect`,
      revocation_endpoint: `${config.issuer}/oauth/revoke`,
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: collectScopes(registry.list().flatMap((client) => client.allowedScopes)),
    }),
  );

  app.get("/__test__/mailbox/latest", (c) => {
    if (!config.exposeTestMailbox) {
      return c.json({ error: "Not found" }, 404);
    }
    const email = c.req.query("email")?.trim().toLowerCase();
    const mail = email
      ? userRuntime.mailbox.filter((entry) => entry.email === email).at(-1)
      : userRuntime.mailbox.at(-1);
    if (!mail) {
      return c.json({ error: "No mailbox entry found" }, 404);
    }
    return c.json(mail);
  });

  app.post("/user/two-factor/enroll", async (c) => {
    const sessionResult = await authAdapter.getSession(c.req.raw);
    if (!sessionResult.response) {
      throw new AuthError("invalid_session", "A valid authenticated session is required", 401);
    }
    const { session, user } = sessionResult.response;
    return c.json(await userLifecycle.enrollRecoveryFactor(session.id, user.email));
  });

  app.post("/user/two-factor/verify", async (c) => {
    const sessionResult = await authAdapter.getSession(c.req.raw);
    if (!sessionResult.response) {
      throw new AuthError("invalid_session", "A valid authenticated session is required", 401);
    }
    const fields = await readBodyFields(c.req.raw);
    const code = fields.code?.trim();
    const kind = fields.kind?.trim();
    if (!code) {
      throw new AuthError("invalid_request", "code is required", 400);
    }
    const { session, user } = sessionResult.response;
    return c.json(
      await userLifecycle.verifyRecoveryFactor(session.id, user.email, {
        code,
        kind: kind === "backup_code" ? "backup_code" : "totp",
      }),
    );
  });

  app.post("/user/onboarding/complete", async (c) => {
    const sessionResult = await authAdapter.getSession(c.req.raw);
    if (!sessionResult.response) {
      throw new AuthError("invalid_session", "A valid authenticated session is required", 401);
    }
    const { session, user } = sessionResult.response;
    await userLifecycle.completeOnboarding(session.id, user.email);
    return c.json({ ok: true, sessionId: session.id, email: user.email });
  });

  app.post("/user/recovery/start", async (c) => {
    const fields = await readBodyFields(c.req.raw);
    const email = fields.email?.trim().toLowerCase();
    if (!email) {
      throw new AuthError("invalid_request", "email is required", 400);
    }
    await userLifecycle.startRecoveryChallenge(email);
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
    return authAdapter.handle(mailRequest);
  });

  app.post("/session/exchange", async (c) => {
    const result = await sessionExchange.exchange(c.req.raw);
    return c.json(result.body, 200, Object.fromEntries(result.headers.entries()));
  });

  app.post("/oauth/token", async (c) => c.json(await handleToken(c.req.raw)));
  app.post("/oauth/introspect", async (c) => c.json(await handleIntrospect(c.req.raw)));
  app.post("/oauth/revoke", async (c) => c.json(await handleRevoke(c.req.raw)));

  return {
    authority,
    registry,
    userRuntime,
    async fetch(input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      return app.fetch(request);
    },
  };
}
