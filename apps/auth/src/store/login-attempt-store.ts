import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { type AuthDatabaseSchema, patchDatabaseRow } from "../service/db/auth-db";

export type LoginAttemptStatus = "pending" | "completed" | "redeemed" | "expired";

export interface LoginAttemptRecord {
  id: string;
  email: string;
  clientId: string;
  purpose: string;
  status: LoginAttemptStatus;
  magicLinkTokenHash?: string | null;
  loginGrantHash?: string | null;
  loginGrantEncrypted?: string | null;
  completedSessionId?: string | null;
  completedSetCookieEncrypted?: string | null;
  expiresAt: string;
  completedAt?: string | null;
  redeemedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoginAttemptStore {
  create(input: {
    email: string;
    clientId: string;
    purpose: string;
    expiresAt: string;
  }): Promise<LoginAttemptRecord>;
  findById(id: string): Promise<LoginAttemptRecord | undefined>;
  updateById(id: string, patch: Partial<LoginAttemptRecord> & Record<string, unknown>): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStatus(value: unknown): LoginAttemptStatus {
  if (
    value === "pending" ||
    value === "completed" ||
    value === "redeemed" ||
    value === "expired"
  ) {
    return value;
  }
  return "pending";
}

function mapRecord(row: Record<string, unknown>): LoginAttemptRecord {
  return {
    id: String(row.id),
    email: normalizeEmail(String(row.email)),
    clientId: String(row.clientId),
    purpose: String(row.purpose),
    status: normalizeStatus(row.status),
    magicLinkTokenHash: normalizeOptionalString(row.magicLinkTokenHash),
    loginGrantHash: normalizeOptionalString(row.loginGrantHash),
    loginGrantEncrypted: normalizeOptionalString(row.loginGrantEncrypted),
    completedSessionId: normalizeOptionalString(row.completedSessionId),
    completedSetCookieEncrypted: normalizeOptionalString(row.completedSetCookieEncrypted),
    expiresAt: String(row.expiresAt),
    completedAt: normalizeOptionalString(row.completedAt),
    redeemedAt: normalizeOptionalString(row.redeemedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function createLoginAttemptStore(db: Kysely<AuthDatabaseSchema>): LoginAttemptStore {
  return {
    async create(input) {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db
        .insertInto("login_attempt")
        .values({
          id,
          email: normalizeEmail(input.email),
          clientId: input.clientId,
          purpose: input.purpose,
          status: "pending",
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      const record = await this.findById(id);
      if (!record) {
        throw new Error(`Login attempt ${id} was not created`);
      }
      return record;
    },

    async findById(id: string) {
      const row = await db
        .selectFrom("login_attempt")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) {
        return undefined;
      }
      return mapRecord(row as unknown as Record<string, unknown>);
    },

    async updateById(id: string, patch) {
      await patchDatabaseRow(db, "login_attempt", "id", id, {
        ...patch,
        updatedAt: new Date().toISOString(),
      } as Record<string, unknown>);
    },
  };
}
