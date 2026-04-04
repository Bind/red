import { describe, expect, test } from "bun:test";
import { createTokenVerifier } from "./sdk/verifier";
import {
  bootstrapMagicLinkSession,
  completePasskeyFlow,
  completeOnboarding,
  completeTotpFlow,
  startRecoveryChallenge,
} from "./testing/human-auth-e2e";
import { createVirtualPasskeyAuthenticator } from "./testing/virtual-passkey-authenticator";
import { createVirtualTotpAuthenticator } from "./testing/virtual-totp-authenticator";

const baseUrl = process.env.AUTH_LAB_E2E_BASE_URL ?? "http://127.0.0.1:4020";
const composeFile = process.env.AUTH_LAB_E2E_COMPOSE_FILE ?? "./docker-compose.yml";

const runE2E = Boolean(process.env.AUTH_LAB_E2E_BASE_URL);
const e2e = runE2E ? describe : describe.skip;

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}/health`);
}

async function requestJson<T>(input: RequestInfo | URL | Request, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

function createTransport() {
  return {
    fetch: (input: RequestInfo | URL | Request, init?: RequestInit) => fetch(input, init),
  };
}

e2e("compose auth stack", () => {
  test("magic-link bootstrap, real passkey flow, real TOTP flow, and session exchange work end to end", async () => {
    await waitForHealth(baseUrl);
    const transport = createTransport();
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseUrl).hostname,
      origin: baseUrl,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();

    const bootstrap = await bootstrapMagicLinkSession(transport, baseUrl, "compose-user@example.com");
    const passkey = await completePasskeyFlow(
      transport,
      baseUrl,
      bootstrap.cookie,
      "compose-user@example.com",
      passkeyAuthenticator
    );
    const totp = await completeTotpFlow(
      transport,
      baseUrl,
      passkey.cookie,
      "compose-user@example.com",
      totpAuthenticator
    );

    await completeOnboarding(transport, baseUrl, totp.cookie);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: {
        origin: baseUrl,
        cookie: totp.cookie,
      },
    });
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      session: { id: string };
      user: { email: string; onboardingState?: string; recoveryReady?: boolean; twoFactorEnabled?: boolean };
    };
    expect(sessionBody.session.id).toBe(totp.sessionId);
    expect(sessionBody.user.email).toBe("compose-user@example.com");
    expect(sessionBody.user.twoFactorEnabled).toBe(true);

    const exchangeResponse = await fetch(`${baseUrl}/session/exchange`, {
      method: "POST",
      headers: { cookie: totp.cookie },
    });
    expect(exchangeResponse.status).toBe(200);
    const tokenBody = (await exchangeResponse.json()) as {
      access_token: string;
      sid: string;
    };
    expect(tokenBody.sid).toBe(totp.sessionId);

    const verifier = createTokenVerifier({
      issuer: baseUrl,
      audience: "redc-api",
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      fetchImpl: (input, init) => fetch(input, init),
    });
    const verified = await verifier.verifyBearerToken(`Bearer ${tokenBody.access_token}`);
    expect(verified.claims.sid).toBe(totp.sessionId);
    expect(verified.claims.onboarding_state).toBe("active");
    expect(verified.claims.amr).toContain("mfa");
  });

  test("recovery challenge without second factor is denied", async () => {
    await waitForHealth(baseUrl);
    const transport = createTransport();
    const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
      rpId: new URL(baseUrl).hostname,
      origin: baseUrl,
    });
    const totpAuthenticator = createVirtualTotpAuthenticator();

    const bootstrap = await bootstrapMagicLinkSession(transport, baseUrl, "compose-recovery@example.com");
    const passkey = await completePasskeyFlow(
      transport,
      baseUrl,
      bootstrap.cookie,
      "compose-recovery@example.com",
      passkeyAuthenticator
    );
    const totp = await completeTotpFlow(
      transport,
      baseUrl,
      passkey.cookie,
      "compose-recovery@example.com",
      totpAuthenticator
    );
    await completeOnboarding(transport, baseUrl, totp.cookie);

    const recovery = await startRecoveryChallenge(transport, baseUrl, "compose-recovery@example.com");

    const response = await fetch(`${baseUrl}/session/exchange`, {
      method: "POST",
      headers: { cookie: recovery.cookie },
    });
    expect(response.status).toBe(403);
  });

  test(
    "restart persistence survives auth container restart",
    async () => {
      await waitForHealth(baseUrl);
      const transport = createTransport();
      const passkeyAuthenticator = createVirtualPasskeyAuthenticator({
        rpId: new URL(baseUrl).hostname,
        origin: baseUrl,
      });
      const totpAuthenticator = createVirtualTotpAuthenticator();

      const bootstrap = await bootstrapMagicLinkSession(transport, baseUrl, "compose-restart@example.com");
      const passkey = await completePasskeyFlow(
        transport,
        baseUrl,
        bootstrap.cookie,
        "compose-restart@example.com",
        passkeyAuthenticator
      );
      const totp = await completeTotpFlow(
        transport,
        baseUrl,
        passkey.cookie,
        "compose-restart@example.com",
        totpAuthenticator
      );
      await completeOnboarding(transport, baseUrl, totp.cookie);

      const before = await requestJson<{ access_token: string; sid: string }>(`${baseUrl}/session/exchange`, {
        method: "POST",
        headers: { cookie: totp.cookie },
      });
      expect(before.sid).toBe(totp.sessionId);

      const restart = Bun.spawnSync(["docker", "compose", "-f", composeFile, "restart", "auth"]);
      expect(restart.exitCode).toBe(0);

      await waitForHealth(baseUrl);

      const after = await requestJson<{ access_token: string; sid: string }>(`${baseUrl}/session/exchange`, {
        method: "POST",
        headers: { cookie: totp.cookie },
      });
      expect(after.sid).toBe(totp.sessionId);
    },
    15_000
  );
});
