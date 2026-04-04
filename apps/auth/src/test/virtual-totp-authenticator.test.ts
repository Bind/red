import { describe, expect, test } from "bun:test";
import { createAuthServer } from "../server";
import {
  bootstrapMagicLinkSession,
  completePasskeyFlow,
  completeTotpFlow,
} from "../test/helpers/user-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "../test/helpers/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "../test/helpers/virtual-totp-authenticator";

const baseConfig = {
  issuer: "http://127.0.0.1:4026",
  audience: "redc-api",
  hostname: "127.0.0.1",
  port: 4026,
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

describe("virtual TOTP authenticator", () => {
  test("generates deterministic codes for fixed timestamps", () => {
    const authenticator = createVirtualTotpAuthenticator();
    const secret = "totp-test-secret";
    expect(authenticator.createCode(secret, 0)).toBe(authenticator.createCode(secret, 0));
    expect(authenticator.verifyCode(secret, authenticator.createCode(secret, 0), 0)).toBe(true);
    expect(authenticator.verifyCode(secret, "000000", 0)).toBe(false);
  });

  test("completes the mounted Better Auth TOTP flow end to end", async () => {
    const server = await createAuthServer(baseConfig);
    const issuer = baseConfig.issuer;
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(issuer).hostname,
      origin: issuer,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();

    try {
      const bootstrap = await bootstrapMagicLinkSession(server, issuer, "totp-test@example.com");
      const passkey = await completePasskeyFlow(
        server,
        issuer,
        bootstrap.cookie,
        "totp-test@example.com",
        passkeyAuthenticator,
      );
      const totp = await completeTotpFlow(
        server,
        issuer,
        passkey.cookie,
        "totp-test@example.com",
        totpAuthenticator,
      );

      const session = await server.userRuntime.auth.api.getSession({
        headers: new Headers({ cookie: totp.cookie }),
        returnHeaders: true,
      });
      expect(session.response).toBeTruthy();
      if (!session.response) throw new Error("Expected session");
      const resolvedSession = session.response as unknown as {
        session: { id: string };
        user: { twoFactorEnabled?: boolean };
      };
      expect(resolvedSession.user.twoFactorEnabled).toBe(true);
      expect(resolvedSession.session.id).toBe(totp.sessionId);
      expect(
        totpAuthenticator.verifyCode(totp.secret, totpAuthenticator.createCode(totp.secret)),
      ).toBe(true);
    } finally {
      await server.userRuntime.close();
    }
  });
});
