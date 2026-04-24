import { createHash, randomBytes } from "node:crypto";
import {
  collectHealthReport,
  createObsSinkFromEnv,
  getEnvelope,
  type ObsFields,
  obsMiddleware,
} from "@red/obs";
import { Hono, type MiddlewareHandler } from "@red/server";
import { parseSetCookieHeader, splitSetCookieHeader } from "better-auth/cookies";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { decodeJwt } from "jose";
import { type BetterAuthAdapter, createBetterAuthAdapter } from "./service/better-auth-adapter";
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
  webClients?: Array<{
    clientId: string;
    redirectBaseUrl: string;
    magicLinkPath?: string;
  }>;
  passkeyOrigins: string[];
  passkeyRpId: string;
  stealthTotpEmails?: string[];
  stealthTotpSeedUser?: {
    id: string;
    email: string;
    name: string;
    totpSecret: string;
  };
  allowAnyTotpCode?: boolean;
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

type ResolvedSessionState = Awaited<ReturnType<BetterAuthAdapter["getSession"]>> & {
  response: NonNullable<Awaited<ReturnType<BetterAuthAdapter["getSession"]>>["response"]>;
};

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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDisplayName(name: string, email: string): string {
  const trimmed = name.trim();
  return trimmed || normalizeEmail(email);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isExpired(isoTimestamp: string): boolean {
  const expiresAt = new Date(isoTimestamp).getTime();
  return Number.isNaN(expiresAt) || Date.now() >= expiresAt;
}

function generateOneTimeGrant(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeClientId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function withRequestIdHeaders(requestId: string, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("x-request-id", requestId);
  return headers;
}

const SESSION_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

function resolveSessionCookie(setCookieHeader: string): { name: string; value: string } | null {
  const cookies = parseSetCookieHeader(setCookieHeader);
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name)?.value;
    if (value) {
      return { name, value };
    }
  }
  return null;
}

export async function createAuthServer(config: AuthServerConfig): Promise<AuthServer> {
  const webClients = new Map(
    (config.webClients ?? []).map((client) => [client.clientId, client] as const),
  );
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
    passkeyOrigins: config.passkeyOrigins,
    passkeyRpId: config.passkeyRpId,
    database: config.database,
  });
  const authAdapter = createBetterAuthAdapter(userRuntime.auth);
  const userLifecycle = createUserLifecycleService(
    userRuntime.stores,
    config.userAuthSecret ?? "redc-auth-lab-dev-secret",
    {
      allowAnyTotpCode: config.allowAnyTotpCode,
    },
  );
  const sessionExchange = createSessionExchangeService(authAdapter, authority);
  const app = new Hono();
  const authSecret = config.userAuthSecret ?? "redc-auth-lab-dev-secret";
  const startedAt = Date.now();

  if (config.stealthTotpSeedUser) {
    const encryptedTotpSecret = await symmetricEncrypt({
      key: authSecret,
      data: config.stealthTotpSeedUser.totpSecret,
    });
    await userRuntime.stores.user.upsertStealthTotpUser({
      id: config.stealthTotpSeedUser.id,
      email: normalizeEmail(config.stealthTotpSeedUser.email),
      name: normalizeDisplayName(config.stealthTotpSeedUser.name, config.stealthTotpSeedUser.email),
      emailVerified: true,
      onboardingState: "active",
      recoveryReady: true,
      recoveryChallengePending: false,
      authAssurance: "passkey+totp",
      twoFactorEnabled: true,
      recoveryTotpSecretEncrypted: encryptedTotpSecret,
    });
  }

  const resolveSessionState = async (request: Request): Promise<ResolvedSessionState | null> => {
    const sessionResult = await authAdapter.getSession(request);
    if (!sessionResult.response) {
      return null;
    }

    const { session } = sessionResult.response;
    const user = { ...sessionResult.response.user };
    const storedUser = await userRuntime.stores.user.findByEmail(user.email);

    if (
      storedUser &&
      storedUser.id === user.id &&
      storedUser.onboardingState === "pending_passkey" &&
      (await userRuntime.stores.user.hasPasskey(user.id))
    ) {
      const nextAuthAssurance =
        typeof storedUser.authAssurance === "string" && storedUser.authAssurance.includes("passkey")
          ? storedUser.authAssurance
          : "passkey";
      await userRuntime.stores.user.updateByEmail(user.email, {
        onboardingState: "pending_recovery_factor",
        authAssurance: nextAuthAssurance,
      });
      user.onboardingState = "pending_recovery_factor";
      user.authAssurance = nextAuthAssurance;
    }

    return {
      ...sessionResult,
      response: {
        session,
        user,
      },
    };
  };

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

  app.use(
    "*",
    obsMiddleware({
      service: "auth",
      sink: createObsSinkFromEnv({ service: "auth" }),
    }) as MiddlewareHandler,
  );

  app.onError((error, c) => {
    getEnvelope(c).fail(error);
    const { status, body } = oauthError(error);
    c.header("x-request-id", getEnvelope(c).requestId);
    return c.json(body, status as 200 | 400 | 401 | 403 | 404 | 500);
  });

  app.notFound((c) => {
    getEnvelope(c).set({
      route: {
        name: "not_found",
      },
    });
    c.header("x-request-id", getEnvelope(c).requestId);
    return c.json({ error: "Not found" }, 404);
  });

  app.all("/api/auth/*", async (c) => authAdapter.handle(c.req.raw));

  app.get("/health", async (c) => {
    const envelope = getEnvelope(c);
    envelope.set({
      route: {
        name: "health",
      },
    });
    const report = await collectHealthReport({
      service: "auth",
      startedAtMs: startedAt,
      checks: {
        database: async () => {
          await userRuntime.database.ping();
          return {
            kind: userRuntime.database.kind,
          };
        },
      },
    });
    envelope.set({
      health: {
        status: report.status,
        checks: report.checks as unknown as ObsFields,
      },
    });

    c.header("x-request-id", envelope.requestId);
    return c.json(report, report.status === "ok" ? 200 : 503);
  });
  app.get("/me", async (c) => {
    const sessionResult = await resolveSessionState(c.req.raw);
    if (!sessionResult) {
      throw new AuthError("invalid_session", "A valid authenticated session is required", 401);
    }
    getEnvelope(c).set({
      route: {
        name: "me",
      },
      auth: {
        session_id: sessionResult.response.session.id,
        user_id: sessionResult.response.user.id,
        onboarding_state: sessionResult.response.user.onboardingState ?? null,
      },
    });
    return c.json(sessionResult.response);
  });

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
    getEnvelope(c).set({
      route: {
        name: "user.two_factor.enroll",
      },
      auth: {
        session_id: session.id,
        user_id: user.id,
      },
    });
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
    getEnvelope(c).set({
      route: {
        name: "user.two_factor.verify",
      },
      auth: {
        session_id: session.id,
        user_id: user.id,
        second_factor_kind: kind === "backup_code" ? "backup_code" : "totp",
      },
    });
    return c.json(
      await userLifecycle.verifyRecoveryFactor(session.id, user.email, {
        code,
        kind: kind === "backup_code" ? "backup_code" : "totp",
      }),
    );
  });

  app.post("/user/totp-login", async (c) => {
    const requestId = getEnvelope(c).requestId;
    const fields = await readBodyFields(c.req.raw);
    const email = fields.email?.trim().toLowerCase();
    const code = fields.code?.trim();
    if (!email || !code) {
      throw new AuthError("invalid_request", "email and code are required", 400);
    }
    getEnvelope(c).set({
      route: {
        name: "user.totp_login",
      },
      auth: {
        email,
        second_factor_kind: "totp",
      },
    });

    await userLifecycle.verifyTotpLogin(email, {
      code,
      allowlistedEmails: config.stealthTotpEmails ?? [],
    });

    const mailboxLengthBefore = userRuntime.mailbox.length;
    const signInResponse = await authAdapter.handle(
      new Request(`${config.issuer}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: withRequestIdHeaders(requestId, {
          origin: config.issuer,
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          email,
          metadata: {
            purpose: "bootstrap",
          },
        }),
      }),
    );
    if (!signInResponse.ok) {
      const message = await signInResponse.text();
      throw new AuthError(
        "server_error",
        message || "Failed to dispatch stealth magic link",
        signInResponse.status,
      );
    }

    const mail = userRuntime.mailbox
      .slice(mailboxLengthBefore)
      .filter((entry) => normalizeEmail(entry.email) === email)
      .at(-1);
    if (!mail?.url) {
      throw new AuthError("server_error", "Stealth magic link was not captured", 500);
    }

    const verifyResponse = await authAdapter.handle(
      new Request(mail.url, {
        method: "GET",
        headers: withRequestIdHeaders(requestId, {
          origin: config.issuer,
        }),
        redirect: "manual",
      }),
    );
    const setCookieHeader = verifyResponse.headers.get("set-cookie");
    if (!setCookieHeader) {
      throw new AuthError("server_error", "Stealth login did not produce a session cookie", 500);
    }

    const sessionCookie = resolveSessionCookie(setCookieHeader);
    if (!sessionCookie) {
      throw new AuthError("server_error", "Stealth login did not yield a session token", 500);
    }

    for (const headerValue of splitSetCookieHeader(setCookieHeader)) {
      c.header("set-cookie", headerValue, { append: true });
    }

    const sessionState = await authAdapter.getSession(
      new Request(`${config.issuer}/api/auth/get-session`, {
        headers: withRequestIdHeaders(requestId, {
          origin: config.issuer,
          cookie: `${sessionCookie.name}=${sessionCookie.value}`,
        }),
      }),
    );
    const session = sessionState.response?.session;
    if (!session) {
      throw new AuthError("server_error", "Stealth login session could not be resolved", 500);
    }

    return c.json({
      ok: true,
      session_id: session.id,
      email,
    });
  });

  app.post("/user/onboarding/complete", async (c) => {
    const sessionResult = await authAdapter.getSession(c.req.raw);
    if (!sessionResult.response) {
      throw new AuthError("invalid_session", "A valid authenticated session is required", 401);
    }
    const { session, user } = sessionResult.response;
    getEnvelope(c).set({
      route: {
        name: "user.onboarding.complete",
      },
      auth: {
        session_id: session.id,
        user_id: user.id,
      },
    });
    await userLifecycle.completeOnboarding(session.id, user.email);
    return c.json({ ok: true, sessionId: session.id, email: user.email });
  });

  app.post("/user/recovery/start", async (c) => {
    const requestId = getEnvelope(c).requestId;
    const fields = await readBodyFields(c.req.raw);
    const email = fields.email?.trim().toLowerCase();
    if (!email) {
      throw new AuthError("invalid_request", "email is required", 400);
    }
    getEnvelope(c).set({
      route: {
        name: "user.recovery.start",
      },
      auth: {
        email,
      },
    });
    await userLifecycle.startRecoveryChallenge(email);
    const mailRequest = new Request(`${config.issuer}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: withRequestIdHeaders(requestId, {
        origin: config.issuer,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        email,
        metadata: {
          purpose: "recovery",
        },
      }),
    });
    return authAdapter.handle(mailRequest);
  });

  app.post("/login-attempts", async (c) => {
    const requestId = getEnvelope(c).requestId;
    const fields = await readBodyFields(c.req.raw);
    const email = fields.email?.trim().toLowerCase();
    const clientId = normalizeClientId(fields.client_id ?? fields.clientId);
    if (!email) {
      throw new AuthError("invalid_request", "email is required", 400);
    }
    if (!clientId) {
      throw new AuthError("invalid_request", "client_id is required", 400);
    }

    const client = webClients.get(clientId);
    if (!client) {
      throw new AuthError("invalid_client", "Unknown browser client", 400);
    }
    getEnvelope(c).set({
      route: {
        name: "login_attempts.create",
      },
      auth: {
        email,
        client_id: clientId,
      },
    });

    const attempt = await userRuntime.stores.loginAttempt.create({
      email,
      clientId,
      purpose: "bootstrap",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    const mailboxLengthBefore = userRuntime.mailbox.length;
    const signInResponse = await authAdapter.handle(
      new Request(`${config.issuer}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: withRequestIdHeaders(requestId, {
          origin: config.issuer,
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          email,
          metadata: {
            purpose: "bootstrap",
          },
        }),
      }),
    );

    if (!signInResponse.ok) {
      const message = await signInResponse.text();
      throw new AuthError(
        "server_error",
        message || "Failed to dispatch magic link",
        signInResponse.status,
      );
    }

    const mail = userRuntime.mailbox
      .slice(mailboxLengthBefore)
      .filter((entry) => normalizeEmail(entry.email) === email)
      .at(-1);
    if (!mail?.token) {
      throw new AuthError("server_error", "Magic link token was not captured", 500);
    }

    await userRuntime.stores.loginAttempt.updateById(attempt.id, {
      magicLinkTokenHash: hashToken(mail.token),
    });
    getEnvelope(c).set({
      login_attempt: {
        id: attempt.id,
        status: "pending",
        purpose: attempt.purpose,
      },
    });

    mail.url =
      new URL(client.magicLinkPath ?? "/auth/magic-link", client.redirectBaseUrl).toString() +
      `?attempt_id=${encodeURIComponent(attempt.id)}&token=${encodeURIComponent(mail.token)}&client_id=${encodeURIComponent(clientId)}`;

    return c.json({
      attempt_id: attempt.id,
      email,
      client_id: clientId,
      status: "pending",
      expires_at: attempt.expiresAt,
    });
  });

  app.get("/login-attempts/:id", async (c) => {
    getEnvelope(c).set({
      route: {
        name: "login_attempts.get",
      },
      login_attempt: {
        id: c.req.param("id"),
      },
    });
    const attempt = await userRuntime.stores.loginAttempt.findById(c.req.param("id"));
    if (!attempt) {
      return c.json({ error: "Not found" }, 404);
    }

    if (attempt.status === "pending" && isExpired(attempt.expiresAt)) {
      await userRuntime.stores.loginAttempt.updateById(attempt.id, { status: "expired" });
      return c.json({
        attempt_id: attempt.id,
        client_id: attempt.clientId,
        status: "expired",
        expires_at: attempt.expiresAt,
      });
    }

    const body: Record<string, unknown> = {
      attempt_id: attempt.id,
      client_id: attempt.clientId,
      status: attempt.status,
      expires_at: attempt.expiresAt,
      session_id: attempt.completedSessionId ?? null,
    };

    if (attempt.status === "completed" && attempt.loginGrantEncrypted) {
      body.login_grant = await symmetricDecrypt({
        key: authSecret,
        data: attempt.loginGrantEncrypted,
      });
    }

    return c.json(body);
  });

  app.post("/magic-link/complete", async (c) => {
    const requestId = getEnvelope(c).requestId;
    const fields = await readBodyFields(c.req.raw);
    const attemptId = fields.attempt_id ?? fields.attemptId;
    const token = fields.token?.trim();
    const clientId = normalizeClientId(fields.client_id ?? fields.clientId);
    if (!attemptId || !token || !clientId) {
      throw new AuthError("invalid_request", "attempt_id, token, and client_id are required", 400);
    }

    const client = webClients.get(clientId);
    if (!client) {
      throw new AuthError("invalid_client", "Unknown browser client", 400);
    }
    getEnvelope(c).set({
      route: {
        name: "magic_link.complete",
      },
      auth: {
        client_id: clientId,
      },
      login_attempt: {
        id: attemptId,
      },
    });

    const attempt = await userRuntime.stores.loginAttempt.findById(attemptId);
    if (!attempt) {
      throw new AuthError("invalid_request", "Unknown login attempt", 404);
    }
    if (attempt.clientId !== clientId) {
      throw new AuthError("invalid_request", "Login attempt client mismatch", 400);
    }
    if (attempt.status === "redeemed") {
      return c.json({ ok: true, status: "redeemed", attempt_id: attempt.id });
    }
    if (attempt.status === "expired" || isExpired(attempt.expiresAt)) {
      await userRuntime.stores.loginAttempt.updateById(attempt.id, { status: "expired" });
      throw new AuthError("invalid_request", "Login attempt has expired", 400);
    }
    if (attempt.magicLinkTokenHash && attempt.magicLinkTokenHash !== hashToken(token)) {
      throw new AuthError(
        "invalid_magic_link",
        "Magic link token did not match the login attempt",
        401,
      );
    }

    const verifyResponse = await authAdapter.handle(
      new Request(
        `${config.issuer}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent("/")}`,
        {
          method: "GET",
          headers: withRequestIdHeaders(requestId, {
            origin: config.issuer,
          }),
          redirect: "manual",
        },
      ),
    );

    if (!verifyResponse.ok && verifyResponse.status !== 302) {
      const body = await verifyResponse.text();
      throw new AuthError(
        "invalid_magic_link",
        body || "Magic link verification failed",
        verifyResponse.status,
      );
    }

    const setCookie = verifyResponse.headers.get("set-cookie");
    const sessionCookie = setCookie ? resolveSessionCookie(setCookie) : null;
    if (!setCookie || !sessionCookie) {
      throw new AuthError("server_error", "Magic link verification did not create a session", 500);
    }

    const sessionResult = await authAdapter.getSession(
      new Request(`${config.issuer}/api/auth/get-session`, {
        headers: withRequestIdHeaders(requestId, {
          cookie: `${sessionCookie.name}=${sessionCookie.value}`,
        }),
      }),
    );
    if (!sessionResult.response) {
      throw new AuthError("server_error", "Verified session could not be resolved", 500);
    }

    const loginGrant = generateOneTimeGrant();
    await userRuntime.stores.loginAttempt.updateById(attempt.id, {
      status: "completed",
      loginGrantHash: hashToken(loginGrant),
      loginGrantEncrypted: await symmetricEncrypt({
        key: authSecret,
        data: loginGrant,
      }),
      completedSessionId: sessionResult.response.session.id,
      completedSetCookieEncrypted: await symmetricEncrypt({
        key: authSecret,
        data: setCookie,
      }),
      completedAt: new Date().toISOString(),
    });
    getEnvelope(c).set({
      auth: {
        session_id: sessionResult.response.session.id,
        user_id: sessionResult.response.user.id,
      },
      login_attempt: {
        id: attempt.id,
        status: "completed",
      },
    });

    return c.json({
      ok: true,
      status: "completed",
      attempt_id: attempt.id,
      session_id: sessionResult.response.session.id,
      client_id: client.clientId,
    });
  });

  app.post("/login-attempts/redeem", async (c) => {
    const fields = await readBodyFields(c.req.raw);
    const attemptId = fields.attempt_id ?? fields.attemptId;
    const loginGrant = fields.login_grant ?? fields.loginGrant;
    if (!attemptId || !loginGrant) {
      throw new AuthError("invalid_request", "attempt_id and login_grant are required", 400);
    }
    getEnvelope(c).set({
      route: {
        name: "login_attempts.redeem",
      },
      login_attempt: {
        id: attemptId,
      },
    });

    const attempt = await userRuntime.stores.loginAttempt.findById(attemptId);
    if (!attempt) {
      throw new AuthError("invalid_request", "Unknown login attempt", 404);
    }
    if (attempt.status === "redeemed") {
      throw new AuthError("invalid_request", "Login attempt has already been redeemed", 400);
    }
    if (
      attempt.status !== "completed" ||
      !attempt.loginGrantHash ||
      !attempt.completedSetCookieEncrypted
    ) {
      throw new AuthError("invalid_request", "Login attempt is not ready for redemption", 400);
    }
    if (attempt.loginGrantHash !== hashToken(loginGrant)) {
      throw new AuthError("invalid_grant", "Login grant is invalid", 401);
    }

    const setCookie = await symmetricDecrypt({
      key: authSecret,
      data: attempt.completedSetCookieEncrypted,
    });

    await userRuntime.stores.loginAttempt.updateById(attempt.id, {
      status: "redeemed",
      redeemedAt: new Date().toISOString(),
      loginGrantHash: null,
      loginGrantEncrypted: null,
      completedSetCookieEncrypted: null,
    });
    getEnvelope(c).set({
      auth: {
        session_id: attempt.completedSessionId ?? null,
      },
      login_attempt: {
        id: attempt.id,
        status: "redeemed",
      },
    });

    return c.json(
      {
        ok: true,
        status: "redeemed",
        attempt_id: attempt.id,
        session_id: attempt.completedSessionId ?? null,
      },
      200,
      {
        "set-cookie": setCookie,
      },
    );
  });

  app.post("/session/exchange", async (c) => {
    const result = await sessionExchange.exchange(c.req.raw);
    getEnvelope(c).set({
      route: {
        name: "session.exchange",
      },
      auth: {
        session_id: typeof result.body.sid === "string" ? result.body.sid : null,
        scope: typeof result.body.scope === "string" ? result.body.scope : null,
      },
    });
    return c.json(result.body, 200, Object.fromEntries(result.headers.entries()));
  });

  app.post("/oauth/token", async (c) => {
    const fields = await readBodyFields(c.req.raw.clone());
    const basic = parseBasicAuth(c.req.raw.headers);
    getEnvelope(c).set({
      route: {
        name: "oauth.token",
      },
      oauth: {
        grant_type: fields.grant_type ?? fields.grantType ?? null,
        client_id: basic?.clientId ?? fields.client_id ?? fields.clientId ?? null,
        audience: fields.audience ?? fields.resource ?? config.audience,
        scope: fields.scope ?? null,
      },
    });
    return c.json(await handleToken(c.req.raw));
  });
  app.post("/oauth/introspect", async (c) => {
    const fields = await readBodyFields(c.req.raw.clone());
    const basic = parseBasicAuth(c.req.raw.headers);
    getEnvelope(c).set({
      route: {
        name: "oauth.introspect",
      },
      oauth: {
        client_id: basic?.clientId ?? fields.client_id ?? fields.clientId ?? null,
        token_client_id: fields.token ? extractTokenClientId(fields.token) : null,
      },
    });
    return c.json(await handleIntrospect(c.req.raw));
  });
  app.post("/oauth/revoke", async (c) => {
    const fields = await readBodyFields(c.req.raw.clone());
    const basic = parseBasicAuth(c.req.raw.headers);
    getEnvelope(c).set({
      route: {
        name: "oauth.revoke",
      },
      oauth: {
        client_id: basic?.clientId ?? fields.client_id ?? fields.clientId ?? null,
        token_client_id: fields.token ? extractTokenClientId(fields.token) : null,
      },
    });
    return c.json(await handleRevoke(c.req.raw));
  });

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
