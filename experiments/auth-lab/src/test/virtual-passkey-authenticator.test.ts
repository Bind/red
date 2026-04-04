import { describe, expect, test } from "bun:test";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { parseSetCookieHeader } from "better-auth/cookies";
import { createAuthServer } from "../server";
import { createVirtualPasskeyAuthenticator } from "../test/helpers/virtual-passkey-authenticator";

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

function cookieHeaderFromSetCookie(
  setCookieHeader: string | null,
  existingCookieHeader = "",
): string {
  const cookies = parseSetCookieHeader(setCookieHeader ?? "");
  const parts = existingCookieHeader ? [existingCookieHeader] : [];
  for (const [name, cookie] of cookies) {
    parts.push(`${name}=${cookie.value}`);
  }
  return parts.join("; ");
}

async function bootstrapMagicLinkSession(
  server: Awaited<ReturnType<typeof createAuthServer>>,
  issuer: string,
  email: string,
): Promise<{ cookie: string; sessionId: string }> {
  const signInResponse = await server.fetch(
    new Request(`${issuer}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        origin: issuer,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        metadata: {
          purpose: "bootstrap",
        },
      }),
    }),
  );

  expect(signInResponse.status).toBe(200);

  const mail = server.userRuntime.mailbox.filter((entry) => entry.email === email).at(-1);
  expect(mail?.url).toBeTruthy();
  if (!mail) {
    throw new Error("Expected magic-link mail to be present");
  }

  const verifyResponse = await server.fetch(
    new Request(mail.url, {
      method: "GET",
      headers: { origin: issuer },
    }),
  );
  expect([200, 302]).toContain(verifyResponse.status);

  const cookie = verifyResponse.headers.get("set-cookie");
  const sessionCookie = parseSetCookieHeader(cookie ?? "").get("better-auth.session_token")?.value;
  expect(sessionCookie).toBeTruthy();

  const session = await server.userRuntime.auth.api.getSession({
    headers: new Headers({ cookie: `better-auth.session_token=${sessionCookie}` }),
    returnHeaders: true,
  });
  expect(session.response?.session.id).toBeTruthy();
  if (!session.response) {
    throw new Error("Expected session to be present");
  }

  return {
    cookie: `better-auth.session_token=${sessionCookie}`,
    sessionId: session.response.session.id,
  };
}

async function requestJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

describe("virtual passkey authenticator", () => {
  test("produces registration and authentication payloads accepted by simplewebauthn", async () => {
    const authenticator = createVirtualPasskeyAuthenticator({
      rpId: "example.com",
      origin: "https://example.com",
    });

    const registrationOptions = await generateRegistrationOptions({
      rpName: "Example RP",
      rpID: "example.com",
      userID: new TextEncoder().encode("virtual-user-1"),
      userName: "virtual-user@example.com",
      userDisplayName: "Virtual User",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    const registration = authenticator.createRegistrationResponse({
      options: registrationOptions,
      userHandle: "virtual-user-1",
    });
    const registrationVerification = await verifyRegistrationResponse({
      response: registration,
      expectedChallenge: registrationOptions.challenge,
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: false,
    });

    expect(registrationVerification.verified).toBe(true);
    expect(registrationVerification.registrationInfo?.credential.id).toBe(registration.id);
    const registrationInfo = registrationVerification.registrationInfo;
    if (!registrationInfo) {
      throw new Error("Expected registration info to be present");
    }

    const authenticationOptions = await generateAuthenticationOptions({
      rpID: "example.com",
      allowCredentials: [
        {
          id: registrationInfo.credential.id,
        },
      ],
      userVerification: "preferred",
    });

    const assertion = authenticator.createAuthenticationResponse({
      options: authenticationOptions,
    });
    const authenticationVerification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: authenticationOptions.challenge,
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      credential: {
        id: registrationInfo.credential.id,
        publicKey: registrationInfo.credential.publicKey,
        counter: registrationInfo.credential.counter,
      },
      requireUserVerification: false,
    });

    expect(authenticationVerification.verified).toBe(true);
    expect(authenticationVerification.authenticationInfo.newCounter).toBe(1);
  });

  test("completes the mounted Better Auth passkey flow end to end", async () => {
    const server = await createAuthServer(baseConfig);
    const issuer = baseConfig.issuer;
    const authenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(issuer).hostname,
      origin: issuer,
    });

    try {
      const bootstrap = await bootstrapMagicLinkSession(server, issuer, "passkey-test@example.com");

      const registerOptionsResponse = await server.fetch(
        new Request(`${issuer}/api/auth/passkey/generate-register-options`, {
          method: "GET",
          headers: {
            origin: issuer,
            cookie: bootstrap.cookie,
          },
        }),
      );
      expect(registerOptionsResponse.status).toBe(200);
      const registerOptions = await registerOptionsResponse.json();
      const registerChallengeCookie = cookieHeaderFromSetCookie(
        registerOptionsResponse.headers.get("set-cookie"),
        bootstrap.cookie,
      );

      const registration = authenticator.createRegistrationResponse({
        options: registerOptions,
        userHandle: "passkey-test@example.com",
      });

      const verifyRegistrationResponseResult = await server.fetch(
        new Request(`${issuer}/api/auth/passkey/verify-registration`, {
          method: "POST",
          headers: {
            origin: issuer,
            cookie: registerChallengeCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            response: registration,
            name: "Virtual Passkey",
          }),
        }),
      );
      expect(verifyRegistrationResponseResult.status).toBe(200);
      const registeredPasskey = await verifyRegistrationResponseResult.json();
      expect(registeredPasskey.credentialID).toBe(registration.id);

      const authenticateOptionsResponse = await server.fetch(
        new Request(`${issuer}/api/auth/passkey/generate-authenticate-options`, {
          method: "GET",
          headers: {
            origin: issuer,
            cookie: bootstrap.cookie,
          },
        }),
      );
      expect(authenticateOptionsResponse.status).toBe(200);
      const authenticateOptions = await authenticateOptionsResponse.json();
      const authenticateChallengeCookie = cookieHeaderFromSetCookie(
        authenticateOptionsResponse.headers.get("set-cookie"),
        bootstrap.cookie,
      );

      const assertion = authenticator.createAuthenticationResponse({
        options: authenticateOptions,
      });

      const verifyAuthenticationResponseResult = await server.fetch(
        new Request(`${issuer}/api/auth/passkey/verify-authentication`, {
          method: "POST",
          headers: {
            origin: issuer,
            cookie: authenticateChallengeCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            response: assertion,
          }),
        }),
      );
      expect(verifyAuthenticationResponseResult.status).toBe(200);
      const authBody = await requestJson<{ session: { id: string } }>(
        verifyAuthenticationResponseResult,
      );
      expect(authBody.session.id).toBeTruthy();

      const finalSessionCookie = parseSetCookieHeader(
        verifyAuthenticationResponseResult.headers.get("set-cookie") ?? "",
      ).get("better-auth.session_token")?.value;
      expect(finalSessionCookie).toBeTruthy();

      const resolvedSession = await server.fetch(
        new Request(`${issuer}/api/auth/get-session`, {
          method: "GET",
          headers: {
            origin: issuer,
            cookie: `better-auth.session_token=${finalSessionCookie}`,
          },
        }),
      );
      expect(resolvedSession.status).toBe(200);
      const sessionBody = await resolvedSession.json();
      expect(sessionBody.user.email).toBe("passkey-test@example.com");
    } finally {
      await server.userRuntime.close();
    }
  });
});
