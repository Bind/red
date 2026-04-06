import { expect } from "bun:test";
import { base32 } from "@better-auth/utils/base32";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { parseSetCookieHeader } from "better-auth/cookies";
import type { VirtualPasskeyAuthenticator } from "./virtual-passkey-authenticator";
import type { VirtualTotpAuthenticator } from "./virtual-totp-authenticator";

export interface UserAuthTransport {
  fetch(input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface BootstrapMagicLinkSessionResult {
  cookie: string;
  sessionId: string;
}

export interface PasskeyFlowResult {
  cookie: string;
  sessionId: string;
  credentialId: string;
}

export interface RecoveryFlowResult {
  cookie: string;
  sessionId: string;
}

export function cookieHeaderFromSetCookie(
  setCookieHeader: string | null,
  existingCookieHeader = "",
): string {
  const mergedCookies = new Map<string, string>();
  if (existingCookieHeader) {
    for (const part of existingCookieHeader.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      mergedCookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }

  const parsedCookies = parseSetCookieHeader(setCookieHeader ?? "");
  for (const [name, cookie] of parsedCookies) {
    mergedCookies.set(name, cookie.value);
  }
  return [...mergedCookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function bootstrapMagicLinkSession(
  transport: UserAuthTransport,
  issuer: string,
  email: string,
  purpose: "bootstrap" | "recovery" = "bootstrap",
): Promise<BootstrapMagicLinkSessionResult> {
  const signInResponse = await transport.fetch(
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

  const mailboxResponse = await transport.fetch(
    `${issuer}/__test__/mailbox/latest?email=${encodeURIComponent(email)}`,
  );
  expect(mailboxResponse.status).toBe(200);
  const mail = (await mailboxResponse.json()) as { url: string; token: string; email: string };
  expect(mail.email).toBe(email);
  expect(mail.url).toBeTruthy();

  const verifyResponse = await transport.fetch(
    new Request(mail.url, {
      method: "GET",
      headers: { origin: issuer },
      redirect: "manual",
    }),
  );
  expect([200, 302]).toContain(verifyResponse.status);

  const sessionCookie = parseSetCookieHeader(verifyResponse.headers.get("set-cookie") ?? "").get(
    "better-auth.session_token",
  )?.value;
  expect(sessionCookie).toBeTruthy();

  const sessionResponse = await transport.fetch(`${issuer}/api/auth/get-session`, {
    headers: {
      origin: issuer,
      cookie: `better-auth.session_token=${sessionCookie}`,
    },
  });
  expect(sessionResponse.status).toBe(200);
  const sessionBody = (await sessionResponse.json()) as {
    session: { id: string };
    user: { email: string; onboardingState?: string; recoveryReady?: boolean };
  };
  expect(sessionBody.session.id).toBeTruthy();
  expect(sessionBody.user.email).toBe(email);

  return {
    cookie: `better-auth.session_token=${sessionCookie}`,
    sessionId: sessionBody.session.id,
  };
}

export async function completePasskeyFlow(
  transport: UserAuthTransport,
  issuer: string,
  bootstrapCookie: string,
  email: string,
  authenticator: VirtualPasskeyAuthenticator,
  browserOrigin = issuer,
): Promise<PasskeyFlowResult> {
  const registerOptionsResponse = await transport.fetch(
    new Request(`${issuer}/api/auth/passkey/generate-register-options`, {
      method: "GET",
      headers: {
        origin: browserOrigin,
        cookie: bootstrapCookie,
      },
    }),
  );
  expect(registerOptionsResponse.status).toBe(200);
  const registerOptions =
    (await registerOptionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
  const registerCookie = cookieHeaderFromSetCookie(
    registerOptionsResponse.headers.get("set-cookie"),
    bootstrapCookie,
  );

  const registration = authenticator.createRegistrationResponse({
    options: registerOptions,
    userHandle: email,
  });
  const verifyRegistrationResponse = await transport.fetch(
    new Request(`${issuer}/api/auth/passkey/verify-registration`, {
      method: "POST",
      headers: {
        origin: browserOrigin,
        cookie: registerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        response: registration,
        name: "Virtual Passkey",
      }),
    }),
  );
  expect(verifyRegistrationResponse.status).toBe(200);
  const registrationBody = (await verifyRegistrationResponse.json()) as { credentialID?: string };
  expect(registrationBody.credentialID).toBe(registration.id);

  const postRegistrationCookie = cookieHeaderFromSetCookie(
    verifyRegistrationResponse.headers.get("set-cookie"),
    registerCookie,
  );

  const authenticateOptionsResponse = await transport.fetch(
    new Request(`${issuer}/api/auth/passkey/generate-authenticate-options`, {
      method: "GET",
      headers: {
        origin: browserOrigin,
        cookie: postRegistrationCookie,
      },
    }),
  );
  expect(authenticateOptionsResponse.status).toBe(200);
  const authenticateOptions =
    (await authenticateOptionsResponse.json()) as PublicKeyCredentialRequestOptionsJSON;
  const authenticateCookie = cookieHeaderFromSetCookie(
    authenticateOptionsResponse.headers.get("set-cookie"),
    postRegistrationCookie,
  );

  const assertion = authenticator.createAuthenticationResponse({
    options: authenticateOptions,
  });
  const verifyAuthenticationResponse = await transport.fetch(
    new Request(`${issuer}/api/auth/passkey/verify-authentication`, {
      method: "POST",
      headers: {
        origin: browserOrigin,
        cookie: authenticateCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        response: assertion satisfies AuthenticationResponseJSON,
      }),
    }),
  );
  expect(verifyAuthenticationResponse.status).toBe(200);

  const finalCookie = cookieHeaderFromSetCookie(
    verifyAuthenticationResponse.headers.get("set-cookie"),
    authenticateCookie,
  );

  const sessionResponse = await transport.fetch(`${issuer}/api/auth/get-session`, {
    headers: {
      origin: browserOrigin,
      cookie: finalCookie,
    },
  });
  expect(sessionResponse.status).toBe(200);
  const sessionBody = (await sessionResponse.json()) as { session: { id: string } };
  expect(sessionBody.session.id).toBeTruthy();

  return {
    cookie: finalCookie,
    sessionId: sessionBody.session.id,
    credentialId: registration.id,
  };
}

export async function completeTotpFlow(
  transport: UserAuthTransport,
  issuer: string,
  activeCookie: string,
  _email: string,
  authenticator: VirtualTotpAuthenticator,
): Promise<{ cookie: string; sessionId: string; secret: string }> {
  const enrollmentResponse = await transport.fetch(
    new Request(`${issuer}/user/two-factor/enroll`, {
      method: "POST",
      headers: {
        origin: issuer,
        cookie: activeCookie,
      },
    }),
  );
  expect(enrollmentResponse.status).toBe(200);
  const enrollmentBody = (await enrollmentResponse.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  expect(enrollmentBody.totpURI).toBeTruthy();
  expect(enrollmentBody.backupCodes.length).toBeGreaterThan(0);
  const secret = parseTotpSecretFromUri(enrollmentBody.totpURI);

  const verifyResponse = await transport.fetch(
    new Request(`${issuer}/user/two-factor/verify`, {
      method: "POST",
      headers: {
        origin: issuer,
        cookie: activeCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: authenticator.createCode(secret),
      }),
    }),
  );
  expect(verifyResponse.status).toBe(200);

  const nextCookie = cookieHeaderFromSetCookie(
    verifyResponse.headers.get("set-cookie"),
    activeCookie,
  );
  const sessionResponse = await transport.fetch(`${issuer}/api/auth/get-session`, {
    headers: {
      origin: issuer,
      cookie: nextCookie,
    },
  });
  expect(sessionResponse.status).toBe(200);
  const sessionBody = (await sessionResponse.json()) as { session: { id: string } };
  expect(sessionBody.session.id).toBeTruthy();

  return {
    cookie: nextCookie,
    sessionId: sessionBody.session.id,
    secret,
  };
}

function parseTotpSecretFromUri(totpURI: string): string {
  const uri = new URL(totpURI);
  const encodedSecret = uri.searchParams.get("secret");
  if (!encodedSecret) {
    throw new Error("TOTP URI was missing a secret");
  }
  return new TextDecoder().decode(base32.decode(encodedSecret));
}

export async function completeOnboarding(
  transport: UserAuthTransport,
  issuer: string,
  cookie: string,
): Promise<void> {
  const response = await transport.fetch(
    new Request(`${issuer}/user/onboarding/complete`, {
      method: "POST",
      headers: {
        origin: issuer,
        cookie,
      },
    }),
  );
  expect(response.status).toBe(200);
}

export async function startRecoveryChallenge(
  transport: UserAuthTransport,
  issuer: string,
  email: string,
): Promise<RecoveryFlowResult> {
  const response = await transport.fetch(
    new Request(`${issuer}/user/recovery/start`, {
      method: "POST",
      headers: {
        origin: issuer,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
    }),
  );
  expect(response.status).toBe(200);

  const mailboxResponse = await transport.fetch(
    `${issuer}/__test__/mailbox/latest?email=${encodeURIComponent(email)}`,
  );
  expect(mailboxResponse.status).toBe(200);
  const mail = (await mailboxResponse.json()) as { url: string; token: string; email: string };
  expect(mail.email).toBe(email);
  expect(mail.url).toBeTruthy();

  const verifyResponse = await transport.fetch(
    new Request(mail.url, {
      method: "GET",
      headers: { origin: issuer },
      redirect: "manual",
    }),
  );
  expect([200, 302]).toContain(verifyResponse.status);

  const sessionCookie = parseSetCookieHeader(verifyResponse.headers.get("set-cookie") ?? "").get(
    "better-auth.session_token",
  )?.value;
  expect(sessionCookie).toBeTruthy();

  const sessionResponse = await transport.fetch(`${issuer}/api/auth/get-session`, {
    headers: {
      origin: issuer,
      cookie: `better-auth.session_token=${sessionCookie}`,
    },
  });
  expect(sessionResponse.status).toBe(200);
  const sessionBody = (await sessionResponse.json()) as { session: { id: string } };
  expect(sessionBody.session.id).toBeTruthy();

  return {
    cookie: `better-auth.session_token=${sessionCookie}`,
    sessionId: sessionBody.session.id,
  };
}
