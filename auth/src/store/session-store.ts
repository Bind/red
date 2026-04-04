import type { Kysely } from "kysely";
import { type AuthDatabaseSchema, patchDatabaseRow } from "../service/db/auth-db";
import type { UserSessionKind } from "../util/types";

export interface SessionStoreRecord {
  id: string;
  userId: string;
  sessionKind?: UserSessionKind;
  authPurpose?: string;
  secondFactorVerified?: boolean;
}

export interface SessionStore {
  findById(sessionId: string): Promise<SessionStoreRecord | undefined>;
  updateById(sessionId: string, patch: Partial<SessionStoreRecord>): Promise<void>;
}

function normalizeSessionKind(value: unknown): UserSessionKind | undefined {
  if (value === "bootstrap" || value === "recovery_challenge" || value === "active") {
    return value;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function createSessionStore(db: Kysely<AuthDatabaseSchema>): SessionStore {
  return {
    async findById(sessionId: string): Promise<SessionStoreRecord | undefined> {
      const session = await db
        .selectFrom("session")
        .select(["id", "userId", "sessionKind", "authPurpose", "secondFactorVerified"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!session) {
        return undefined;
      }
      return {
        ...session,
        sessionKind: normalizeSessionKind(session.sessionKind),
        authPurpose: normalizeOptionalString(session.authPurpose),
        secondFactorVerified: Boolean(session.secondFactorVerified),
      };
    },

    async updateById(sessionId: string, patch: Partial<SessionStoreRecord>): Promise<void> {
      await patchDatabaseRow(db, "session", "id", sessionId, patch as Record<string, unknown>);
    },
  };
}
