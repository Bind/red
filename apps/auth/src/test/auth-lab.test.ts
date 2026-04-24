import { describe, expect, test } from "bun:test";
import { createOTP } from "@better-auth/utils/otp";
import { parseSetCookieHeader } from "better-auth/cookies";
import { createTokenVerifier } from "../sdk/verifier";
import { createAuthServer } from "../server";
import {
  bootstrapMagicLinkSession as bootstrapUserMagicLinkSession,
  completeOnboarding,
  completePasskeyFlow,
  completeTotpFlow,
  startRecoveryChallenge,
} from "../test/helpers/user-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "../test/helpers/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "../test/helpers/virtual-totp-authenticator";

const baseConfig = {
  issuer: "http://127.0.0.1:4020",
  audience: "redc-api",
  hostname: "127.0.0.1",
  port: 4020,
  exposeTestMailbox: true,
  stealthTotpEmails: ["douglasjbinder@gmail.com"],
  webClients: [
    {
      clientId: "redc-web",
      redirectBaseUrl: "http://localhost:5173",
      magicLinkPath: "/auth/magic-link",
    },
  ],
  passkeyOrigins: ["http://localhost:5173"],
  passkeyRpId: "localhost",
  database: {
    kind: "sqlite" as const,
    sqlitePath: ":memory:",
  },
  seedClients: [
    {
      clientId: "claw-runner-dev",
      clientSecret: "dev-secret",
      allowedScopes: ["prs:create", "changes:read"],
      allowedAudiences: ["redc-api"],
      tokenTtlSeconds: 300,
      status: "active" as const,
      allowedGrantTypes: ["client_credentials"] as const,
    },
  ],
};

const dualClientConfig = {
  ...baseConfig,
  seedClients: [
    ...baseConfig.seedClients,
    {
      clientId: "claw-runner-alt",
      clientSecret: "alt-secret",
      allowedScopes: ["prs:create", "changes:read"],
      allowedAudiences: ["redc-api", "other-api"],
      tokenTtlSeconds: 300,
      status: "active" as const,
      allowedGrantTypes: ["client_credentials"] as const,
    },
  ],
};

const webOrigin = baseConfig.webClients[0]?.redirectBaseUrl ?? baseConfig.issuer;

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function mintToken(
  server: Awaited<ReturnType<typeof createAuthServer>>,
  clientId: string,
  clientSecret: string,
  audience: string,
  scope = "prs:create",
) {
  const response = await server.fetch(
    new Request("http://127.0.0.1:4020/oauth/token", {
      method: "POST",
      headers: {
        authorization: basicAuthHeader(clientId, clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope,
        audience,
      }),
    }),
  );

  return response.json() as Promise<{ access_token: string } & Record<string, unknown>>;
}

async function bootstrapMagicLinkSession(
  server: Awaited<ReturnType<typeof createAuthServer>>,
  issuer: string,
  email: string,
  purpose: "bootstrap" | "recovery" = "bootstrap",
): Promise<{ cookie: string; sessionId: string }> {
  const signInResponse = await server.userRuntime.auth.handler(
    new Request(`${issuer}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        origin: issuer,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        metadata: {
          purpose,
        },
      }),
    }),
  );

  expect(signInResponse.status).toBe(200);
  expect(server.userRuntime.mailbox).toHaveLength(1);

  const mail = server.userRuntime.mailbox[0];
  expect(mail).toBeTruthy();
  expect(mail.token).toBeTruthy();
  expect(mail.url).toBeTruthy();

  const verifyResponse = await server.fetch(
    new Request(mail.url, {
      method: "GET",
      headers: { origin: issuer },
    }),
  );
  expect([200, 302]).toContain(verifyResponse.status);

  const cookies = parseSetCookieHeader(verifyResponse.headers.get("set-cookie") ?? "");
  const sessionCookie = cookies.get("better-auth.session_token")?.value;
  expect(sessionCookie).toBeTruthy();

  const resolved = await server.userRuntime.auth.api.getSession({
    headers: new Headers({
      cookie: `better-auth.session_token=${sessionCookie}`,
    }),
    returnHeaders: true,
  });
  expect(resolved.response).toBeTruthy();
  if (!resolved.response) throw new Error("Expected session");
  const resolvedSession = resolved.response as unknown as {
    session: { id: string };
    user: { email: string; onboardingState?: string; recoveryReady?: boolean };
  };
  expect(resolvedSession.user.email).toBe(email);
  expect(resolvedSession.user.onboardingState).toBe("pending_passkey");
  expect(resolvedSession.user.recoveryReady).toBe(false);

  return {
    cookie: `better-auth.session_token=${sessionCookie}`,
    sessionId: resolvedSession.session.id,
  };
}

async function exchangeSession(
  server: Awaited<ReturnType<typeof createAuthServer>>,
  issuer: string,
  cookie?: string,
) {
  return server.fetch(
    new Request(`${issuer}/session/exchange`, {
      method: "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
      },
    }),
  );
}

describe("auth lab", () => {
  test("reports dependency-aware health", async () => {
    const server = await createAuthServer(baseConfig);
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/health", {
        headers: {
          "x-request-id": "health-test-request",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("health-test-request");
    const body = (await response.json()) as {
      status: string;
      service: string;
      uptime_ms: number;
      checks: {
        database: {
          kind: string;
          status: string;
        };
      };
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("auth");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(body.checks.database.kind).toBe("sqlite");
    expect(body.checks.database.status).toBe("ok");
  });

  test("issues client_credentials tokens", async () => {
    const server = await createAuthServer(baseConfig);
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/token", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("claw-runner-dev:dev-secret").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "prs:create",
          audience: "redc-api",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("prs:create");
  });

  test("rejects invalid client auth", async () => {
    const server = await createAuthServer(baseConfig);
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/token", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("claw-runner-dev:wrong").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "prs:create",
          audience: "redc-api",
        }),
      }),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid_client");
  });

  test("rejects overbroad scope requests", async () => {
    const server = await createAuthServer(baseConfig);
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/token", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("claw-runner-dev:dev-secret").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "prs:create admin",
          audience: "redc-api",
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_scope");
  });

  test("blocks client A from introspecting client B tokens", async () => {
    const server = await createAuthServer(dualClientConfig);
    const token = await mintToken(server, "claw-runner-alt", "alt-secret", "redc-api");
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/introspect", {
        method: "POST",
        headers: {
          authorization: basicAuthHeader("claw-runner-dev", "dev-secret"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: token.access_token }),
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("access_denied");
  });

  test("blocks client A from revoking client B tokens", async () => {
    const server = await createAuthServer(dualClientConfig);
    const token = await mintToken(server, "claw-runner-alt", "alt-secret", "redc-api");
    const response = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/revoke", {
        method: "POST",
        headers: {
          authorization: basicAuthHeader("claw-runner-dev", "dev-secret"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: token.access_token }),
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("access_denied");
  });

  test("rejects wrong-audience tokens in internal verification paths", async () => {
    const server = await createAuthServer(dualClientConfig);
    const token = await mintToken(server, "claw-runner-alt", "alt-secret", "other-api");
    const introspectResponse = await server.fetch(
      new Request("http://127.0.0.1:4020/oauth/introspect", {
        method: "POST",
        headers: {
          authorization: basicAuthHeader("claw-runner-alt", "alt-secret"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: token.access_token }),
      }),
    );
    expect(introspectResponse.status).toBe(200);
    expect(await introspectResponse.json()).toEqual({ active: false });

    await expect(server.authority.verifyAccessToken(token.access_token)).rejects.toThrow(
      /unexpected "aud" claim value/,
    );
  });

  test("denies session exchange without a session cookie", async () => {
    const server = await createAuthServer(baseConfig);
    const response = await exchangeSession(server, baseConfig.issuer);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid_session");
  });

  test("supports cross-device login attempts with web callback URLs and one-time redemption", async () => {
    const server = await createAuthServer(baseConfig);

    const createResponse = await server.fetch(
      new Request("http://127.0.0.1:4020/login-attempts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "cross-device@example.com",
          client_id: "redc-web",
        }),
      }),
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      attempt_id: string;
      status: string;
      client_id: string;
    };
    expect(created.status).toBe("pending");
    expect(created.client_id).toBe("redc-web");
    expect(server.userRuntime.mailbox.at(-1)?.url).toContain(
      `http://localhost:5173/auth/magic-link?attempt_id=${created.attempt_id}`,
    );

    const pendingResponse = await server.fetch(
      new Request(`http://127.0.0.1:4020/login-attempts/${created.attempt_id}`),
    );
    expect(pendingResponse.status).toBe(200);
    expect(await pendingResponse.json()).toMatchObject({
      attempt_id: created.attempt_id,
      status: "pending",
      client_id: "redc-web",
    });

    const token = server.userRuntime.mailbox.at(-1)?.token;
    expect(token).toBeTruthy();

    const completeResponse = await server.fetch(
      new Request("http://127.0.0.1:4020/magic-link/complete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: created.attempt_id,
          token,
          client_id: "redc-web",
        }),
      }),
    );
    expect(completeResponse.status).toBe(200);

    const completedResponse = await server.fetch(
      new Request(`http://127.0.0.1:4020/login-attempts/${created.attempt_id}`),
    );
    expect(completedResponse.status).toBe(200);
    const completed = (await completedResponse.json()) as {
      attempt_id: string;
      status: string;
      session_id: string;
      login_grant: string;
    };
    expect(completed.status).toBe("completed");
    expect(completed.session_id).toBeTruthy();
    expect(completed.login_grant).toBeTruthy();

    const redeemResponse = await server.fetch(
      new Request("http://127.0.0.1:4020/login-attempts/redeem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: created.attempt_id,
          login_grant: completed.login_grant,
        }),
      }),
    );
    expect(redeemResponse.status).toBe(200);
    const setCookie = redeemResponse.headers.get("set-cookie");
    expect(setCookie).toContain("better-auth.session_token=");

    const sessionCookie = parseSetCookieHeader(setCookie ?? "").get(
      "better-auth.session_token",
    )?.value;
    const sessionResponse = await server.fetch(
      new Request("http://127.0.0.1:4020/api/auth/get-session", {
        headers: {
          origin: baseConfig.issuer,
          cookie: `better-auth.session_token=${sessionCookie}`,
        },
      }),
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      session: { id: string };
      user: { email: string };
    };
    expect(sessionBody.user.email).toBe("cross-device@example.com");
    expect(sessionBody.session.id).toBe(completed.session_id);
  });

  test("denies bootstrap-only sessions from receiving privileged JWTs", async () => {
    const server = await createAuthServer(baseConfig);
    const bootstrap = await bootstrapMagicLinkSession(
      server,
      baseConfig.issuer,
      "bootstrap@example.com",
    );
    const response = await exchangeSession(server, baseConfig.issuer, bootstrap.cookie);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("forbidden");
  });

  test("denies recovery-challenge sessions without second factor", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();
    const bootstrap = await bootstrapUserMagicLinkSession(
      server,
      baseConfig.issuer,
      "recovery@example.com",
    );
    const passkey = await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      "recovery@example.com",
      passkeyAuthenticator,
      webOrigin,
    );
    const totp = await completeTotpFlow(
      transport,
      baseConfig.issuer,
      passkey.cookie,
      "recovery@example.com",
      totpAuthenticator,
    );
    await completeOnboarding(server, baseConfig.issuer, totp.cookie);

    const recovery = await startRecoveryChallenge(
      server,
      baseConfig.issuer,
      "recovery@example.com",
    );
    const response = await exchangeSession(server, baseConfig.issuer, recovery.cookie);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("forbidden");
  });

  test("resolved me state advances to recovery-factor setup once a passkey exists", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const bootstrap = await bootstrapUserMagicLinkSession(
      server,
      baseConfig.issuer,
      "passkey-state@example.com",
    );

    await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      "passkey-state@example.com",
      passkeyAuthenticator,
      webOrigin,
    );

    const meResponse = await server.fetch(
      new Request(`${baseConfig.issuer}/me`, {
        headers: {
          cookie: bootstrap.cookie,
        },
      }),
    );
    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      user: { onboardingState?: string; authAssurance?: string | null };
    };
    expect(meBody.user.onboardingState).toBe("pending_recovery_factor");
    expect(meBody.user.authAssurance).toContain("passkey");
  });

  test("exchanges an active session for a service JWT with expected claims", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();
    const bootstrap = await bootstrapUserMagicLinkSession(
      server,
      baseConfig.issuer,
      "active@example.com",
    );
    const passkey = await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      "active@example.com",
      passkeyAuthenticator,
      webOrigin,
    );
    const totp = await completeTotpFlow(
      transport,
      baseConfig.issuer,
      passkey.cookie,
      "active@example.com",
      totpAuthenticator,
    );
    await completeOnboarding(server, baseConfig.issuer, totp.cookie);

    const response = await exchangeSession(server, baseConfig.issuer, totp.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      audience: string;
      sid: string;
      subject: string;
      scope: string;
    };

    expect(body.token_type).toBe("Bearer");
    expect(body.audience).toBe(baseConfig.audience);
    expect(body.sid).toBe(totp.sessionId);
    expect(body.subject.startsWith("user:")).toBe(true);
    expect(body.scope).toContain("session:exchange");
    expect(body.scope).toContain("repos:read");
    expect(body.scope).toContain("repos:create");
    expect(body.scope).toContain("changes:read");

    const verifier = createTokenVerifier({
      issuer: baseConfig.issuer,
      audience: baseConfig.audience,
      jwksUrl: `${baseConfig.issuer}/.well-known/jwks.json`,
      fetchImpl: (input, init) => server.fetch(input, init),
    });
    const verified = await verifier.verifyBearerToken(`Bearer ${body.access_token}`);

    expect(verified.subject).toBe(body.subject);
    expect(verified.claims.sid).toBe(totp.sessionId);
    expect(verified.claims.email).toBe("active@example.com");
    expect(verified.claims.onboarding_state).toBe("active");
    expect(verified.claims.recovery_ready).toBe(true);
    expect(verified.scope).toEqual(
      expect.arrayContaining(["session:exchange", "repos:read", "repos:create", "changes:read"]),
    );
    expect(verified.claims.amr).toEqual(expect.arrayContaining(["passkey"]));
  });

  test("valid session can exchange for JWT", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();
    const bootstrap = await bootstrapUserMagicLinkSession(
      server,
      baseConfig.issuer,
      "valid@example.com",
    );
    const passkey = await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      "valid@example.com",
      passkeyAuthenticator,
      webOrigin,
    );
    const totp = await completeTotpFlow(
      transport,
      baseConfig.issuer,
      passkey.cookie,
      "valid@example.com",
      totpAuthenticator,
    );
    await completeOnboarding(server, baseConfig.issuer, totp.cookie);

    const response = await exchangeSession(server, baseConfig.issuer, totp.cookie);
    expect(response.status).toBe(200);
  });

  test("allowlisted email can create a session with TOTP only", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();
    const email = "douglasjbinder@gmail.com";
    const bootstrap = await bootstrapUserMagicLinkSession(server, baseConfig.issuer, email);
    const passkey = await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      email,
      passkeyAuthenticator,
      webOrigin,
    );
    const totp = await completeTotpFlow(
      transport,
      baseConfig.issuer,
      passkey.cookie,
      email,
      totpAuthenticator,
    );
    await completeOnboarding(server, baseConfig.issuer, totp.cookie);

    const loginResponse = await server.fetch(
      new Request(`${baseConfig.issuer}/user/totp-login`, {
        method: "POST",
        headers: {
          origin: baseConfig.issuer,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          code: totpAuthenticator.createCode(totp.secret),
        }),
      }),
    );
    expect(loginResponse.status).toBe(200);

    const sessionCookie = parseSetCookieHeader(loginResponse.headers.get("set-cookie") ?? "").get(
      "better-auth.session_token",
    )?.value;
    expect(sessionCookie).toBeTruthy();

    const sessionResponse = await server.fetch(
      new Request(`${baseConfig.issuer}/api/auth/get-session`, {
        headers: {
          origin: baseConfig.issuer,
          cookie: `better-auth.session_token=${sessionCookie}`,
        },
      }),
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      session: { id: string };
      user: { email: string };
    };
    expect(sessionBody.user.email).toBe(email);
    expect(sessionBody.session.id).toBeTruthy();
  });

  test("seeded stealth TOTP user can create a session without prior onboarding", async () => {
    const totpSecret = "JBSWY3DPEHPK3PXP";
    const server = await createAuthServer({
      ...baseConfig,
      stealthTotpSeedUser: {
        id: "seeded-douglas",
        email: "douglasjbinder@gmail.com",
        name: "Douglas Binder",
        totpSecret,
      },
    });
    const code = await createOTP(totpSecret, { digits: 6, period: 30 }).totp();

    const loginResponse = await server.fetch(
      new Request(`${baseConfig.issuer}/user/totp-login`, {
        method: "POST",
        headers: {
          origin: baseConfig.issuer,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "douglasjbinder@gmail.com",
          code,
        }),
      }),
    );
    expect(loginResponse.status).toBe(200);

    const sessionCookie = parseSetCookieHeader(loginResponse.headers.get("set-cookie") ?? "").get(
      "better-auth.session_token",
    )?.value;
    expect(sessionCookie).toBeTruthy();

    const sessionResponse = await server.fetch(
      new Request(`${baseConfig.issuer}/api/auth/get-session`, {
        headers: {
          origin: baseConfig.issuer,
          cookie: `better-auth.session_token=${sessionCookie}`,
        },
      }),
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      user: { email: string; onboardingState?: string; recoveryReady?: boolean };
    };
    expect(sessionBody.user.email).toBe("douglasjbinder@gmail.com");
    expect(sessionBody.user.onboardingState).toBe("active");
    expect(sessionBody.user.recoveryReady).toBe(true);
  });

  test("downstream verifier validates exchanged JWT by JWKS", async () => {
    const server = await createAuthServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();
    const bootstrap = await bootstrapUserMagicLinkSession(
      server,
      baseConfig.issuer,
      "jwks@example.com",
    );
    const passkey = await completePasskeyFlow(
      transport,
      baseConfig.issuer,
      bootstrap.cookie,
      "jwks@example.com",
      passkeyAuthenticator,
      webOrigin,
    );
    const totp = await completeTotpFlow(
      transport,
      baseConfig.issuer,
      passkey.cookie,
      "jwks@example.com",
      totpAuthenticator,
    );
    await completeOnboarding(server, baseConfig.issuer, totp.cookie);

    const exchangeResponse = await exchangeSession(server, baseConfig.issuer, totp.cookie);
    const exchangeBody = (await exchangeResponse.json()) as { access_token: string };

    const verifier = createTokenVerifier({
      issuer: baseConfig.issuer,
      audience: baseConfig.audience,
      jwksUrl: `${baseConfig.issuer}/.well-known/jwks.json`,
      fetchImpl: (input, init) => server.fetch(input, init),
    });
    const verified = await verifier.verifyBearerToken(`Bearer ${exchangeBody.access_token}`);

    expect(verified.subject.startsWith("user:")).toBe(true);
    expect(verified.claims.sid).toBe(totp.sessionId);
  });
});
