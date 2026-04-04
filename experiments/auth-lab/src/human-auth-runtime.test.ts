import { describe, expect, test } from "bun:test";
import { createAuthLabServer } from "./server";
import { createTokenVerifier } from "./sdk/verifier";
import {
  bootstrapMagicLinkSession,
  completePasskeyFlow,
  completeOnboarding,
  completeTotpFlow,
} from "./testing/human-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "./testing/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "./testing/virtual-totp-authenticator";

const baseConfig = {
  issuer: "http://127.0.0.1:4025",
  audience: "redc-api",
  hostname: "127.0.0.1",
  port: 4025,
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

describe("human auth runtime", () => {
  test("mounts Better Auth magic-link bootstrap, passkey flow, TOTP flow, and session exchange", async () => {
    const server = await createAuthLabServer(baseConfig);
    const issuer = baseConfig.issuer;
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(issuer).hostname,
      origin: issuer,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();

    try {
      const bootstrap = await bootstrapMagicLinkSession(server, issuer, "new-user@example.com");
      const passkey = await completePasskeyFlow(
        server,
        issuer,
        bootstrap.cookie,
        "new-user@example.com",
        passkeyAuthenticator
      );
      const totp = await completeTotpFlow(
        server,
        issuer,
        passkey.cookie,
        "new-user@example.com",
        totpAuthenticator
      );

      const resolved = await server.humanRuntime.auth.api.getSession({
        headers: new Headers({ cookie: totp.cookie }),
      });
      expect(resolved).toBeTruthy();
      expect(resolved!.user.email).toBe("new-user@example.com");
      expect(resolved!.user.onboardingState).toBe("pending_recovery_factor");
      expect(resolved!.user.twoFactorEnabled).toBe(true);

      await completeOnboarding(server, issuer, totp.cookie);

      const exchangeResponse = await server.fetch(
        new Request(`${issuer}/session/exchange`, {
          method: "POST",
          headers: {
            cookie: totp.cookie,
          },
        })
      );
      expect(exchangeResponse.status).toBe(200);
      const tokenBody = (await exchangeResponse.json()) as {
        access_token: string;
        sid: string;
      };
      expect(tokenBody.sid).toBe(totp.sessionId);

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
    } finally {
      await server.humanRuntime.close();
    }
  });
});
