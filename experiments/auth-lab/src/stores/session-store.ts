import type { Kysely } from "kysely";
import { patchDatabaseRow } from "../auth-db";
import type { UserSessionKind } from "../utils/types";

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

export function createSessionStore(db: Kysely<any>): SessionStore {
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
        secondFactorVerified: Boolean(session.secondFactorVerified),
      };
    },

    async updateById(sessionId: string, patch: Partial<SessionStoreRecord>): Promise<void> {
      await patchDatabaseRow(db, "session", "id", sessionId, patch as Record<string, unknown>);
    },
  };
}
