import { describe, expect, test } from "bun:test";
import { createTokenVerifier } from "../sdk/verifier";
import { createAuthServer } from "../server";
import {
  bootstrapMagicLinkSession,
  completeOnboarding,
  completePasskeyFlow,
  completeTotpFlow,
} from "../test/helpers/user-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "../test/helpers/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "../test/helpers/virtual-totp-authenticator";

const baseConfig = {
  issuer: "http://127.0.0.1:4025",
  audience: "redc-api",
  hostname: "127.0.0.1",
  port: 4025,
  exposeTestMailbox: true,
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

const webOrigin = baseConfig.webClients[0]?.redirectBaseUrl ?? baseConfig.issuer;

describe("user auth runtime", () => {
  test("mounts Better Auth magic-link bootstrap, passkey flow, TOTP flow, and session exchange", async () => {
    const server = await createAuthServer(baseConfig);
    const issuer = baseConfig.issuer;
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();

    try {
      const bootstrap = await bootstrapMagicLinkSession(server, issuer, "new-user@example.com");
      const passkey = await completePasskeyFlow(
        server,
        issuer,
        bootstrap.cookie,
        "new-user@example.com",
        passkeyAuthenticator,
        webOrigin,
      );
      const totp = await completeTotpFlow(
        server,
        issuer,
        passkey.cookie,
        "new-user@example.com",
        totpAuthenticator,
      );

      const resolved = await server.userRuntime.auth.api.getSession({
        headers: new Headers({ cookie: totp.cookie }),
        returnHeaders: true,
      });
      expect(resolved.response).toBeTruthy();
      if (!resolved.response) throw new Error("Expected session");
      const resolvedSession = resolved.response as unknown as {
        session: { id: string };
        user: {
          email: string;
          onboardingState?: string;
          twoFactorEnabled?: boolean;
        };
      };
      expect(resolvedSession.user.email).toBe("new-user@example.com");
      expect(resolvedSession.user.onboardingState).toBe("pending_recovery_factor");
      expect(resolvedSession.user.twoFactorEnabled).toBe(true);

      await completeOnboarding(server, issuer, totp.cookie);

      const exchangeResponse = await server.fetch(
        new Request(`${issuer}/session/exchange`, {
          method: "POST",
          headers: {
            cookie: totp.cookie,
          },
        }),
      );
      expect(exchangeResponse.status).toBe(200);
      const tokenBody = (await exchangeResponse.json()) as {
        access_token: string;
        sid: string;
        scope: string;
      };
      expect(tokenBody.sid).toBe(totp.sessionId);
      expect(tokenBody.scope).toContain("session:exchange");
      expect(tokenBody.scope).toContain("repos:read");
      expect(tokenBody.scope).toContain("repos:create");
      expect(tokenBody.scope).toContain("changes:read");

      const verifier = createTokenVerifier({
        issuer,
        audience: "redc-api",
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetchImpl: (input, init) => server.fetch(input, init),
      });
      const verified = await verifier.verifyBearerToken(`Bearer ${tokenBody.access_token}`);
      expect(verified.claims.sid).toBe(totp.sessionId);
      expect(verified.claims.onboarding_state).toBe("active");
      expect(verified.claims.recovery_ready).toBe(true);
      expect(verified.claims.amr).toContain("passkey");
      expect(verified.claims.amr).toContain("mfa");
      expect(verified.scope).toEqual(
        expect.arrayContaining(["session:exchange", "repos:read", "repos:create", "changes:read"]),
      );
    } finally {
      await server.userRuntime.close();
    }
  });

  test("allows any TOTP code when the dev bypass is enabled", async () => {
    const server = await createAuthServer({
      ...baseConfig,
      allowAnyTotpCode: true,
    });
    const issuer = baseConfig.issuer;
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(webOrigin).hostname,
      origin: webOrigin,
    });

    try {
      const bootstrap = await bootstrapMagicLinkSession(server, issuer, "bypass@example.com");
      const passkey = await completePasskeyFlow(
        server,
        issuer,
        bootstrap.cookie,
        "bypass@example.com",
        passkeyAuthenticator,
        webOrigin,
      );

      const enrollmentResponse = await server.fetch(
        new Request(`${issuer}/user/two-factor/enroll`, {
          method: "POST",
          headers: {
            origin: issuer,
            cookie: passkey.cookie,
          },
        }),
      );
      expect(enrollmentResponse.status).toBe(200);

      const verifyResponse = await server.fetch(
        new Request(`${issuer}/user/two-factor/verify`, {
          method: "POST",
          headers: {
            origin: issuer,
            cookie: passkey.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            code: "000000",
          }),
        }),
      );
      expect(verifyResponse.status).toBe(200);
      expect(await verifyResponse.json()).toEqual({
        sessionKind: "active",
        secondFactorVerified: true,
      });
    } finally {
      await server.userRuntime.close();
    }
  });
});
