import type { Kysely } from "kysely";
import { type AuthDatabaseSchema, patchDatabaseRow } from "../service/db/auth-db";
import type { UserAccountState } from "../util/types";

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

function normalizeAccountState(value: unknown): UserAccountState | undefined {
  if (value === "pending_passkey" || value === "pending_recovery_factor" || value === "active") {
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

export function createUserStore(db: Kysely<AuthDatabaseSchema>): UserStore {
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
        onboardingState: normalizeAccountState(user.onboardingState),
        recoveryReady: normalizeBoolean(user.recoveryReady),
        recoveryChallengePending: normalizeBoolean(user.recoveryChallengePending),
        authAssurance: normalizeOptionalString(user.authAssurance),
        twoFactorEnabled: normalizeBoolean(user.twoFactorEnabled),
        recoveryTotpSecretEncrypted: normalizeOptionalString(user.recoveryTotpSecretEncrypted),
        recoveryBackupCodesEncrypted: normalizeOptionalString(user.recoveryBackupCodesEncrypted),
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
