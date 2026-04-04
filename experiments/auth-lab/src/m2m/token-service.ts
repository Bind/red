import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  importJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { randomUUID } from "node:crypto";
import { AuthLabError } from "../errors";
import {
  normalizeRequestedScopes,
  resolveRequestedAudience,
  type MachineClientRegistry,
} from "./registry";

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  audience: string;
  client_id: string;
}

export interface SessionExchangeTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  audience: string;
  subject: string;
  sid: string;
}

export interface TokenVerificationResult {
  active: boolean;
  client_id?: string;
  scope?: string;
  audience?: string | string[];
  exp?: number;
  sub?: string;
  grant_type?: string;
  jti?: string;
  claims?: Record<string, unknown>;
}

export interface TokenAuthority {
  issuer: string;
  jwks: { keys: JWK[] };
  kid: string;
  issueClientCredentialsToken(input: {
    clientId: string;
    clientSecret: string;
    scope?: string;
    audience?: string;
  }): Promise<OAuthTokenResponse>;
  issueSessionExchangeToken(input: {
    subject: string;
    sid: string;
    email: string;
    amr: string[];
    onboardingState: string;
    recoveryReady: boolean;
    scope?: string;
    audience?: string;
    expiresInSeconds?: number;
  }): Promise<SessionExchangeTokenResponse>;
  verifyAccessToken(token: string): Promise<TokenVerificationResult>;
  introspectToken(token: string): Promise<TokenVerificationResult>;
  revokeToken(token: string): Promise<void>;
}

function toPlainObject(payload: JWTPayload): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter((entry): entry is [string, unknown] => entry[1] !== undefined)
  );
}

export async function createTokenAuthority(input: {
  issuer: string;
  defaultAudience: string;
  registry: MachineClientRegistry;
  signingPrivateJwk?: string;
}): Promise<TokenAuthority> {
  let effectivePrivateKey: Awaited<ReturnType<typeof importJWK>>;
  let publicJwk: JWK;
  if (input.signingPrivateJwk) {
    const parsed = JSON.parse(input.signingPrivateJwk) as JWK;
    effectivePrivateKey = await importJWK(parsed, "RS256");
    const { d, p, q, dp, dq, qi, ...publicOnly } = parsed;
    publicJwk = publicOnly;
  } else {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    effectivePrivateKey = privateKey;
    publicJwk = await exportJWK(publicKey);
  }
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwk: JWK = { ...publicJwk, alg: "RS256", use: "sig", kid };
  const jwks = { keys: [jwk] };
  const jwkSet = createLocalJWKSet(jwks);
  // TODO: Persist revoked JTIs in shared storage before treating revocation as durable.
  // The current in-memory set is reset on process restart and is not shared across instances.
  const revokedJtis = new Set<string>();

  const signAccessToken = async (payload: {
    subject: string;
    audience: string;
    expiresInSeconds: number;
    claims: Record<string, unknown>;
  }): Promise<{ token: string; jti: string }> => {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const token = await new SignJWT(payload.claims)
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(input.issuer)
      .setAudience(payload.audience)
      .setSubject(payload.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + payload.expiresInSeconds)
      .setJti(jti)
      .sign(effectivePrivateKey);
    return { token, jti };
  };

  const issueClientCredentialsToken = async (tokenRequest: {
    clientId: string;
    clientSecret: string;
    scope?: string;
    audience?: string;
  }): Promise<OAuthTokenResponse> => {
    const client = input.registry.authenticate(tokenRequest.clientId, tokenRequest.clientSecret);
    if (!client.allowedGrantTypes.includes("client_credentials")) {
      throw new AuthLabError("unauthorized_client", "client_credentials not allowed", 400);
    }

    const scopeList = normalizeRequestedScopes(tokenRequest.scope, client.allowedScopes);
    const audience = resolveRequestedAudience(tokenRequest.audience ?? input.defaultAudience, client.allowedAudiences);
    const expiresIn = client.tokenTtlSeconds;
    const scope = scopeList.join(" ");
    const { token } = await signAccessToken({
      subject: `client:${client.clientId}`,
      audience,
      expiresInSeconds: expiresIn,
      claims: {
        scope,
        client_id: client.clientId,
        grant_type: "client_credentials",
      },
    });

    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope,
      audience,
      client_id: client.clientId,
    };
  };

  const issueSessionExchangeToken = async (sessionToken: {
    subject: string;
    sid: string;
    email: string;
    amr: string[];
    onboardingState: string;
    recoveryReady: boolean;
    scope?: string;
    audience?: string;
    expiresInSeconds?: number;
  }): Promise<SessionExchangeTokenResponse> => {
    const audience = resolveRequestedAudience(sessionToken.audience ?? input.defaultAudience, [
      input.defaultAudience,
    ]);
    const expiresIn = Math.max(60, Math.trunc(sessionToken.expiresInSeconds ?? 600));
    const scope = sessionToken.scope ?? "session:exchange";
    const { token } = await signAccessToken({
      subject: sessionToken.subject,
      audience,
      expiresInSeconds: expiresIn,
      claims: {
        sid: sessionToken.sid,
        email: sessionToken.email,
        amr: [...new Set(sessionToken.amr)],
        onboarding_state: sessionToken.onboardingState,
        recovery_ready: sessionToken.recoveryReady,
        scope,
        grant_type: "session_exchange",
      },
    });

    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope,
      audience,
      subject: sessionToken.subject,
      sid: sessionToken.sid,
    };
  };

  const verifyAccessToken = async (token: string): Promise<TokenVerificationResult> => {
    const result = await jwtVerify(token, jwkSet, {
      issuer: input.issuer,
      audience: input.defaultAudience,
    });

    if (typeof result.payload.jti === "string" && revokedJtis.has(result.payload.jti)) {
      throw new AuthLabError("invalid_token", "Token has been revoked", 401);
    }

    return {
      active: true,
      client_id: typeof result.payload.client_id === "string" ? result.payload.client_id : undefined,
      scope: typeof result.payload.scope === "string" ? result.payload.scope : undefined,
      audience: result.payload.aud,
      exp: typeof result.payload.exp === "number" ? result.payload.exp : undefined,
      sub: typeof result.payload.sub === "string" ? result.payload.sub : undefined,
      grant_type: typeof result.payload.grant_type === "string" ? result.payload.grant_type : undefined,
      jti: typeof result.payload.jti === "string" ? result.payload.jti : undefined,
      claims: toPlainObject(result.payload),
    };
  };

  const introspectToken = async (token: string): Promise<TokenVerificationResult> => {
    try {
      return await verifyAccessToken(token);
    } catch {
      return { active: false };
    }
  };

  const revokeToken = async (token: string): Promise<void> => {
    try {
      const result = await jwtVerify(token, jwkSet, {
        issuer: input.issuer,
        audience: input.defaultAudience,
      });
      const jti = result.payload.jti;
      if (typeof jti === "string") {
        revokedJtis.add(jti);
        return;
      }
      throw new AuthLabError("invalid_token", "Token is missing jti", 401);
    } catch (error) {
      if (error instanceof AuthLabError) {
        throw error;
      }
      throw new AuthLabError("invalid_token", "Token cannot be revoked", 401);
    }
  };

  return {
    issuer: input.issuer,
    jwks,
    kid,
    issueClientCredentialsToken,
    issueSessionExchangeToken,
    verifyAccessToken,
    introspectToken,
    revokeToken,
  };
}
