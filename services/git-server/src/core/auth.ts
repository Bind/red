import { createHmac, timingSafeEqual } from "node:crypto";

export type RepoAccess = "read" | "write";

export interface RepoAccessTokenClaims {
  v: 1;
  sub: string;
  repoId: string;
  access: RepoAccess;
  exp: number;
}

export interface GitCredentialIssuer {
  issueRepoCredentials(input: {
    actorId: string;
    repoId: string;
    access: RepoAccess;
    ttlSeconds: number;
  }): {
    username: string;
    password: string;
  };
}

export interface GitRequestAuthorizer {
  authorizeBasicAuth(
    authorizationHeader: string | null,
    input: {
      repoId: string;
      requiredAccess: RepoAccess;
    }
  ): {
    ok: true;
    subject: string;
    access: RepoAccess | "admin";
  } | {
    ok: false;
    reason: string;
  };
}

export interface SharedSecretGitAuthOptions {
  adminUsername?: string;
  adminPassword?: string;
  tokenSecret?: string;
}

export class SharedSecretGitAuth implements GitCredentialIssuer, GitRequestAuthorizer {
  constructor(private readonly options: SharedSecretGitAuthOptions) {}

  issueRepoCredentials(input: {
    actorId: string;
    repoId: string;
    access: RepoAccess;
    ttlSeconds: number;
  }) {
    if (!this.options.tokenSecret) {
      throw new Error("Cannot issue repo credentials without tokenSecret");
    }

    return {
      username: input.actorId,
      password: signAccessToken({
        secret: this.options.tokenSecret,
        actorId: input.actorId,
        repoId: input.repoId,
        access: input.access,
        ttlSeconds: input.ttlSeconds,
      }),
    };
  }

  authorizeBasicAuth(
    authorizationHeader: string | null,
    input: {
      repoId: string;
      requiredAccess: RepoAccess;
    }
  ) {
    if (!this.options.adminUsername && !this.options.tokenSecret) {
      return {
        ok: false as const,
        reason: "Auth provider is not configured",
      };
    }

    if (!authorizationHeader?.startsWith("Basic ")) {
      return {
        ok: false as const,
        reason: "Missing basic auth credentials",
      };
    }

    let username = "";
    let password = "";
    try {
      const decoded = atob(authorizationHeader.slice("Basic ".length));
      const separator = decoded.indexOf(":");
      if (separator === -1) {
        return { ok: false as const, reason: "Malformed basic auth credentials" };
      }
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    } catch {
      return { ok: false as const, reason: "Malformed basic auth credentials" };
    }

    if (
      this.options.adminUsername &&
      this.options.adminPassword &&
      username === this.options.adminUsername &&
      password === this.options.adminPassword
    ) {
      return {
        ok: true as const,
        subject: username,
        access: "admin" as const,
      };
    }

    const token = verifyAccessToken(password, this.options.tokenSecret);
    if (!token) {
      return { ok: false as const, reason: "Invalid access token" };
    }
    if (token.sub !== username) {
      return { ok: false as const, reason: "Credential subject mismatch" };
    }
    if (token.repoId !== input.repoId) {
      return {
        ok: false as const,
        reason: `Credentials do not allow access to ${input.repoId}`,
      };
    }
    if (!accessAllows(token.access, input.requiredAccess)) {
      return {
        ok: false as const,
        reason: `Credentials do not allow ${input.requiredAccess} access to ${input.repoId}`,
      };
    }

    return {
      ok: true as const,
      subject: token.sub,
      access: token.access,
    };
  }
}

export function verifyAccessToken(token: string, secret?: string): RepoAccessTokenClaims | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts;

  let payload: RepoAccessTokenClaims;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as RepoAccessTokenClaims;
  } catch {
    return null;
  }

  if (payload.v !== 1) return null;
  if (Date.now() >= payload.exp * 1000) return null;

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  try {
    if (
      !timingSafeEqual(
        Buffer.from(encodedSignature, "base64url"),
        Buffer.from(expectedSignature, "base64url")
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return payload;
}

export function signAccessToken(options: {
  secret: string;
  actorId: string;
  repoId: string;
  access: RepoAccess;
  ttlSeconds: number;
}) {
  const payload: RepoAccessTokenClaims = {
    v: 1,
    sub: options.actorId,
    repoId: options.repoId,
    access: options.access,
    exp: Math.floor(Date.now() / 1000) + options.ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", options.secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function accessAllows(granted: RepoAccess, required: RepoAccess) {
  return granted === "write" || granted === required;
}
