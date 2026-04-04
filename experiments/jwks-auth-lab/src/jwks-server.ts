import {
  createLocalJWKSet,
  exportJWK,
  jwtVerify,
  SignJWT,
  calculateJwkThumbprint,
  generateKeyPair,
  type JWTPayload,
  type JWK,
} from "jose";

export interface JwksAuthServerConfig {
  issuer: string;
  audience: string;
  port: number;
  hostname: string;
}

export interface IssueTokenInput {
  sub?: string;
  aud?: string | string[];
  scope?: string;
  expiresInSeconds?: number;
  claims?: JWTPayload;
}

export interface IssuedToken {
  token: string;
  expiresInSeconds: number;
  issuer: string;
  audience: string | string[];
  kid: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JwksAuthServerConfig {
  const port = Number.parseInt(env.JWKS_AUTH_PORT ?? "4010", 10);
  const hostname = env.JWKS_AUTH_HOST ?? "127.0.0.1";
  const issuer = env.JWKS_AUTH_ISSUER ?? `http://${hostname}:${port}`;
  const audience = env.JWKS_AUTH_AUDIENCE ?? "redc-jwks-lab";

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid JWKS_AUTH_PORT: ${env.JWKS_AUTH_PORT}`);
  }

  return { issuer, audience, port, hostname };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON request body must be an object");
  }
  return body as Record<string, unknown>;
}

export async function createJwksAuthServer(config: JwksAuthServerConfig) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwk: JWK = { ...publicJwk, alg: "RS256", use: "sig", kid };
  const jwks = { keys: [jwk] };
  const jwkSet = createLocalJWKSet(jwks);

  async function issueToken(input: IssueTokenInput = {}): Promise<IssuedToken> {
    const expiresInSeconds = Math.max(1, Math.trunc(input.expiresInSeconds ?? 3600));
    const audience = input.aud ?? config.audience;
    const claims: JWTPayload = {
      ...(input.claims ?? {}),
      scope: input.scope ?? (typeof input.claims?.scope === "string" ? input.claims.scope : "read:protected"),
    };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(config.issuer)
      .setAudience(audience)
      .setSubject(input.sub ?? "test-user")
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .setJti(crypto.randomUUID())
      .sign(privateKey);

    return {
      token,
      expiresInSeconds,
      issuer: config.issuer,
      audience,
      kid,
    };
  }

  async function verifyToken(token: string) {
    return jwtVerify(token, jwkSet, {
      issuer: config.issuer,
      audience: config.audience,
    });
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return jsonResponse(jwks);
    }

    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer: config.issuer,
        jwks_uri: `${config.issuer}/.well-known/jwks.json`,
        token_endpoint: `${config.issuer}/token`,
      });
    }

    if (request.method === "POST" && url.pathname === "/token") {
      try {
        const body = await parseJsonBody(request);
        const issued = await issueToken({
          sub: typeof body.sub === "string" ? body.sub : undefined,
          aud: typeof body.aud === "string" || Array.isArray(body.aud)
            ? body.aud as string | string[]
            : undefined,
          scope: typeof body.scope === "string" ? body.scope : undefined,
          expiresInSeconds: typeof body.expiresInSeconds === "number"
            ? body.expiresInSeconds
            : undefined,
          claims: body.claims && typeof body.claims === "object" && !Array.isArray(body.claims)
            ? body.claims as JWTPayload
            : undefined,
        });
        return jsonResponse(issued, { status: 201 });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "Invalid token request" },
          { status: 400 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/protected") {
      const token = getBearerToken(request);
      if (!token) {
        return jsonResponse({ error: "Missing bearer token" }, { status: 401 });
      }

      try {
        const result = await verifyToken(token);
        return jsonResponse({
          ok: true,
          protected: true,
          subject: result.payload.sub ?? null,
          scope: typeof result.payload.scope === "string" ? result.payload.scope : null,
          payload: result.payload,
          header: result.protectedHeader,
        });
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "Token verification failed" },
          { status: 401 }
        );
      }
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  return {
    config,
    jwks,
    kid,
    issueToken,
    verifyToken,
    fetch: handleRequest,
  };
}
