import type { Kysely } from "kysely";
import { type AuthDatabaseSchema, patchDatabaseRow } from "../service/db/auth-db";
import type { UserAccountState } from "../util/types";

export interface UserStoreRecord {
  id: string;
  name?: string;
  email: string;
  emailVerified?: boolean;
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
  upsertStealthTotpUser(
    record: Required<Pick<UserStoreRecord, "id" | "email">> &
      Pick<
        UserStoreRecord,
        | "name"
        | "emailVerified"
        | "onboardingState"
        | "recoveryReady"
        | "recoveryChallengePending"
        | "authAssurance"
        | "twoFactorEnabled"
        | "recoveryTotpSecretEncrypted"
        | "recoveryBackupCodesEncrypted"
      >,
  ): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBoolean(value: unknown): boolean {
  return Boolean(value);
}

function normalizeBooleanOrUndefined(value: unknown): boolean | undefined {
  return value === undefined ? undefined : Boolean(value);
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

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

export function createUserStore(db: Kysely<AuthDatabaseSchema>): UserStore {
  return {
    async findByEmail(email: string): Promise<UserStoreRecord | undefined> {
      const user = await db
        .selectFrom("user")
        .select([
          "id",
          "name",
          "email",
          "emailVerified",
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
        name: normalizeName(user.name),
        emailVerified: normalizeBooleanOrUndefined(user.emailVerified),
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

    async upsertStealthTotpUser(record) {
      const now = new Date().toISOString();
      await db
        .insertInto("user")
        .values({
          id: record.id,
          name: record.name ?? "",
          email: normalizeEmail(record.email),
          emailVerified: record.emailVerified ?? true,
          createdAt: now,
          updatedAt: now,
          onboardingState: record.onboardingState ?? "active",
          recoveryReady: record.recoveryReady ?? true,
          recoveryChallengePending: record.recoveryChallengePending ?? false,
          authAssurance: record.authAssurance ?? "passkey+totp",
          twoFactorEnabled: record.twoFactorEnabled ?? true,
          recoveryTotpSecretEncrypted: record.recoveryTotpSecretEncrypted,
          recoveryBackupCodesEncrypted: record.recoveryBackupCodesEncrypted,
        })
        .onConflict((conflict) =>
          conflict.column("email").doUpdateSet({
            id: record.id,
            name: record.name ?? "",
            emailVerified: record.emailVerified ?? true,
            updatedAt: now,
            onboardingState: record.onboardingState ?? "active",
            recoveryReady: record.recoveryReady ?? true,
            recoveryChallengePending: record.recoveryChallengePending ?? false,
            authAssurance: record.authAssurance ?? "passkey+totp",
            twoFactorEnabled: record.twoFactorEnabled ?? true,
            recoveryTotpSecretEncrypted: record.recoveryTotpSecretEncrypted,
            recoveryBackupCodesEncrypted: record.recoveryBackupCodesEncrypted,
          }),
        )
        .execute();
    },
  };
}
