import { describe, expect, test } from "bun:test";
import { parseSetCookieHeader } from "better-auth/cookies";
import { createTokenVerifier } from "../sdk/verifier";
import { createAuthLabServer } from "../server";
import {
  bootstrapMagicLinkSession as bootstrapUserMagicLinkSession,
  completeOnboarding,
  completePasskeyFlow,
  completeTotpFlow,
  startRecoveryChallenge,
} from "../testing/user-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "../testing/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "../testing/virtual-totp-authenticator";

const baseConfig = {
  issuer: "http://127.0.0.1:4020",
  audience: "redc-api",
  hostname: "127.0.0.1",
  port: 4020,
  exposeTestMailbox: true,
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

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function mintToken(
  server: Awaited<ReturnType<typeof createAuthLabServer>>,
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
  server: Awaited<ReturnType<typeof createAuthLabServer>>,
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
  });
  expect(resolved).toBeTruthy();
  expect(resolved.user.email).toBe(email);
  expect(resolved.user.onboardingState).toBe("pending_passkey");
  expect(resolved.user.recoveryReady).toBe(false);

  return {
    cookie: `better-auth.session_token=${sessionCookie}`,
    sessionId: resolved.session.id,
  };
}

async function exchangeSession(
  server: Awaited<ReturnType<typeof createAuthLabServer>>,
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
  test("issues client_credentials tokens", async () => {
    const server = await createAuthLabServer(baseConfig);
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
    const server = await createAuthLabServer(baseConfig);
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
    const server = await createAuthLabServer(baseConfig);
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
    const server = await createAuthLabServer(dualClientConfig);
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
    const server = await createAuthLabServer(dualClientConfig);
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
    const server = await createAuthLabServer(dualClientConfig);
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
    const server = await createAuthLabServer(baseConfig);
    const response = await exchangeSession(server, baseConfig.issuer);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid_session");
  });

  test("denies bootstrap-only sessions from receiving privileged JWTs", async () => {
    const server = await createAuthLabServer(baseConfig);
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
    const server = await createAuthLabServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseConfig.issuer).hostname,
      origin: baseConfig.issuer,
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

  test("exchanges an active session for a service JWT with expected claims", async () => {
    const server = await createAuthLabServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseConfig.issuer).hostname,
      origin: baseConfig.issuer,
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
    expect(body.scope).toBe("session:exchange");

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
    expect(verified.scope).toEqual(["session:exchange"]);
    expect(verified.claims.amr).toEqual(expect.arrayContaining(["passkey"]));
  });

  test("valid session can exchange for JWT", async () => {
    const server = await createAuthLabServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseConfig.issuer).hostname,
      origin: baseConfig.issuer,
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

  test("downstream verifier validates exchanged JWT by JWKS", async () => {
    const server = await createAuthLabServer(baseConfig);
    const transport = {
      fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => server.fetch(input, init),
    };
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseConfig.issuer).hostname,
      origin: baseConfig.issuer,
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
