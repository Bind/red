import type { Kysely } from "kysely";
import { patchDatabaseRow } from "../auth-db";
import type { UserAccountState } from "../utils/types";

export interface UserStoreRecord {
  id: string;
  email: string;
  onboardingState?: UserAccountState;
  recoveryReady?: boolean;
  recoveryChallengePending?: boolean;
  authAssurance?: string;
  twoFactorEnabled?: boolean;
  recoveryTotpSecretEncrypted?: string;
  recoveryBackupCodesEncrypted?: string;
}

export interface UserStore {
  findByEmail(email: string): Promise<UserStoreRecord | undefined>;
  hasPasskey(userId: string): Promise<boolean>;
  updateByEmail(email: string, patch: Partial<UserStoreRecord>): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBoolean(value: unknown): boolean {
  return Boolean(value);
}

export function createUserStore(db: Kysely<any>): UserStore {
  return {
    async findByEmail(email: string): Promise<UserStoreRecord | undefined> {
      const user = await db
        .selectFrom("user")
        .select([
          "id",
          "email",
          "onboardingState",
          "recoveryReady",
          "recoveryChallengePending",
          "authAssurance",
          "twoFactorEnabled",
          "recoveryTotpSecretEncrypted",
          "recoveryBackupCodesEncrypted",
        ])
        .where("email", "=", normalizeEmail(email))
        .executeTakeFirst();
      if (!user) {
        return undefined;
      }
      return {
        ...user,
        recoveryReady: normalizeBoolean(user.recoveryReady),
        recoveryChallengePending: normalizeBoolean(user.recoveryChallengePending),
        twoFactorEnabled: normalizeBoolean(user.twoFactorEnabled),
      };
    },

    async hasPasskey(userId: string): Promise<boolean> {
      const passkey = await db
        .selectFrom("passkey")
        .select(["id"])
        .where("userId", "=", userId)
        .executeTakeFirst();
      return Boolean(passkey);
    },

    async updateByEmail(email: string, patch: Partial<UserStoreRecord>): Promise<void> {
      await patchDatabaseRow(
        db,
        "user",
        "email",
        normalizeEmail(email),
        patch as Record<string, unknown>,
      );
    },
  };
}
