import { AuthLabError } from "../../utils/errors";
import { hashClientSecret, verifyClientSecret } from "./secret";

export type MachineClientStatus = "active" | "disabled" | "revoked";

export interface MachineClientSeed {
  clientId: string;
  clientSecret: string;
  allowedScopes: string[];
  allowedAudiences: string[];
  tokenTtlSeconds?: number;
  status?: MachineClientStatus;
  allowedGrantTypes?: readonly ["client_credentials"] | string[];
}

export interface MachineClientRecord {
  clientId: string;
  secretHash: string;
  allowedScopes: string[];
  allowedAudiences: string[];
  tokenTtlSeconds: number;
  status: MachineClientStatus;
  allowedGrantTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MachineClientRegistry {
  register(seed: MachineClientSeed): MachineClientRecord;
  get(clientId: string): MachineClientRecord | undefined;
  authenticate(clientId: string, clientSecret: string): MachineClientRecord;
  list(): MachineClientRecord[];
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function normalizeAudiences(audiences: readonly string[]): string[] {
  return [...new Set(audiences.map((audience) => audience.trim()).filter(Boolean))].sort();
}

function normalizeAllowedGrantTypes(grantTypes?: readonly string[]): string[] {
  const normalized = grantTypes?.length ? grantTypes : ["client_credentials"];
  return [...new Set(normalized.map((grantType) => grantType.trim()).filter(Boolean))].sort();
}

function nowIso() {
  return new Date().toISOString();
}

export function createMachineClientRegistry(
  initialSeeds: MachineClientSeed[] = [],
): MachineClientRegistry {
  const records = new Map<string, MachineClientRecord>();

  const register = (seed: MachineClientSeed): MachineClientRecord => {
    const record: MachineClientRecord = {
      clientId: seed.clientId,
      secretHash: hashClientSecret(seed.clientSecret),
      allowedScopes: normalizeScopes(seed.allowedScopes),
      allowedAudiences: normalizeAudiences(seed.allowedAudiences),
      tokenTtlSeconds: Math.max(1, Math.trunc(seed.tokenTtlSeconds ?? 300)),
      status: seed.status ?? "active",
      allowedGrantTypes: normalizeAllowedGrantTypes(seed.allowedGrantTypes),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    records.set(record.clientId, record);
    return record;
  };

  for (const seed of initialSeeds) {
    register(seed);
  }

  return {
    register,
    get(clientId: string) {
      return records.get(clientId);
    },
    authenticate(clientId: string, clientSecret: string) {
      const record = records.get(clientId);
      if (!record) {
        throw new AuthLabError("invalid_client", "Unknown client", 401);
      }
      if (record.status !== "active") {
        throw new AuthLabError("invalid_client", "Client is not active", 401);
      }
      if (!verifyClientSecret(clientSecret, record.secretHash)) {
        throw new AuthLabError("invalid_client", "Invalid client secret", 401);
      }
      return record;
    },
    list() {
      return [...records.values()].sort((a, b) => a.clientId.localeCompare(b.clientId));
    },
  };
}

export function normalizeRequestedScopes(
  requestedScope: string | undefined,
  allowedScopes: string[],
): string[] {
  const requested = normalizeScopes((requestedScope ?? "").split(/\s+/));
  if (requested.length === 0) {
    return [...allowedScopes];
  }

  const allowed = new Set(allowedScopes);
  for (const scope of requested) {
    if (!allowed.has(scope)) {
      throw new AuthLabError("invalid_scope", `Scope not allowed: ${scope}`, 400);
    }
  }
  return requested;
}

export function resolveRequestedAudience(
  requestedAudience: string | undefined,
  allowedAudiences: string[],
): string {
  if (allowedAudiences.length === 0) {
    throw new AuthLabError("invalid_target", "Client has no allowed audiences", 400);
  }
  if (!requestedAudience) {
    return allowedAudiences[0];
  }
  if (!allowedAudiences.includes(requestedAudience)) {
    throw new AuthLabError("invalid_target", `Audience not allowed: ${requestedAudience}`, 400);
  }
  return requestedAudience;
}
