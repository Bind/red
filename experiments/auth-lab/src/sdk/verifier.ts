import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";

export interface TokenVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  fetchImpl?: (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface VerifiedAccessToken {
  subject: string;
  clientId: string;
  scope: string[];
  audience: string | string[];
  expiresAt: number;
  claims: Record<string, unknown>;
}

export interface TokenVerifier {
  verifyBearerToken(authHeader: string | null): Promise<VerifiedAccessToken>;
}

function parseScopes(scope: unknown): string[] {
  if (Array.isArray(scope)) {
    return scope.flatMap((item) => (typeof item === "string" ? item.split(/\s+/) : []));
  }
  if (typeof scope === "string") {
    return scope.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function toPlainObject(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] !== undefined));
}

export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    ...(config.fetchImpl
      ? {
          [customFetch]: async (url, options) =>
            config.fetchImpl!(new Request(url, options as RequestInit)),
        }
      : {}),
  });

  return {
    async verifyBearerToken(authHeader: string | null): Promise<VerifiedAccessToken> {
      if (!authHeader) {
        throw new Error("Missing bearer token");
      }

      const [scheme, token] = authHeader.split(/\s+/);
      if (scheme?.toLowerCase() !== "bearer" || !token) {
        throw new Error("Invalid bearer token");
      }

      const result = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      });

      const payload = result.payload as Record<string, unknown>;
      return {
        subject: typeof payload.sub === "string" ? payload.sub : "",
        clientId: typeof payload.client_id === "string" ? payload.client_id : "",
        scope: parseScopes(payload.scope),
        audience: typeof payload.aud === "string" || Array.isArray(payload.aud) ? payload.aud : config.audience,
        expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : 0,
        claims: toPlainObject(payload),
      };
    },
  };
}
