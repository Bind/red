import { betterAuth } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { jwt, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { createOTP } from "@better-auth/utils/otp";
import { randomUUID } from "node:crypto";
import { createAuthLabDatabase, patchDatabaseRow, type AuthLabDatabaseKind } from "./auth-db";
import type { UserAccountState, UserSessionKind } from "./user-auth-policy";

export interface MagicLinkMail {
  email: string;
  token: string;
  url: string;
  purpose: "bootstrap" | "recovery" | "unknown";
}

export interface UserAuthRuntimeDatabaseConfig {
  kind: AuthLabDatabaseKind;
  sqlitePath?: string;
  postgresUrl?: string;
}

export interface UserAuthRuntimeConfig {
  issuer: string;
  audience: string;
  hostname: string;
  port: number;
  secret: string;
  database: UserAuthRuntimeDatabaseConfig;
}

export interface AppUserStatePatch {
  onboardingState?: UserAccountState;
  recoveryReady?: boolean;
  recoveryChallengePending?: boolean;
  authAssurance?: string;
  twoFactorEnabled?: boolean;
  recoveryTotpSecretEncrypted?: string;
  recoveryBackupCodesEncrypted?: string;
}

export interface AppSessionStatePatch {
  sessionKind?: UserSessionKind;
  authPurpose?: string;
  secondFactorVerified?: boolean;
}

export interface UserAuthRuntime {
  auth: any;
  mailbox: MagicLinkMail[];
  runMigrations(): Promise<void>;
  getUserByEmail(email: string): Promise<
    | {
        id: string;
        email: string;
        onboardingState?: string;
        recoveryReady?: boolean;
        authAssurance?: string;
        twoFactorEnabled?: boolean;
      }
    | undefined
  >;
  promoteAccountToActiveBySession(sessionId: string, email: string): Promise<void>;
  enrollRecoveryFactorBySession(
    sessionId: string,
    email: string,
  ): Promise<{ totpURI: string; backupCodes: string[] }>;
  verifyRecoveryFactorBySession(
    sessionId: string,
    email: string,
    input: { code: string; kind?: "totp" | "backup_code" },
  ): Promise<{ sessionKind: "active" | "recovery_challenge"; secondFactorVerified: boolean }>;
  startRecoveryChallengeByEmail(email: string): Promise<void>;
  close(): Promise<void>;
}

export async function createUserAuthRuntime(
  config: UserAuthRuntimeConfig,
): Promise<UserAuthRuntime> {
  const mailbox: MagicLinkMail[] = [];
  const rpId = new URL(config.issuer).hostname;
  const database = await createAuthLabDatabase(config.database);
  const { kysely } = database;

  const auth = betterAuth({
    appName: "redc-auth-lab",
    baseURL: config.issuer,
    basePath: "/api/auth",
    secret: config.secret,
    database: { db: kysely, type: config.database.kind },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      storeSessionInDatabase: true,
      preserveSessionInDatabase: true,
      additionalFields: {
        sessionKind: {
          type: "string",
          required: false,
        },
        authPurpose: {
          type: "string",
          required: false,
        },
        secondFactorVerified: {
          type: "boolean",
          required: false,
        },
      },
    },
    user: {
      additionalFields: {
        onboardingState: {
          type: "string",
          required: false,
        },
        recoveryReady: {
          type: "boolean",
          required: false,
        },
        recoveryChallengePending: {
          type: "boolean",
          required: false,
        },
        authAssurance: {
          type: "string",
          required: false,
        },
        twoFactorEnabled: {
          type: "boolean",
          required: false,
        },
        recoveryTotpSecretEncrypted: {
          type: "string",
          required: false,
        },
        recoveryBackupCodesEncrypted: {
          type: "string",
          required: false,
        },
      },
    },
    verification: {
      storeInDatabase: true,
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            return {
              data: {
                ...user,
                onboardingState: (user.onboardingState as string | undefined) ?? "pending_passkey",
                recoveryReady: (user.recoveryReady as boolean | undefined) ?? false,
                recoveryChallengePending:
                  (user.recoveryChallengePending as boolean | undefined) ?? false,
                authAssurance: (user.authAssurance as string | undefined) ?? "bootstrap",
              },
            };
          },
        },
      },
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url, token, metadata }) => {
          mailbox.push({
            email,
            url,
            token,
            purpose:
              metadata && typeof metadata === "object" && typeof metadata.purpose === "string"
                ? (metadata.purpose as MagicLinkMail["purpose"])
                : "unknown",
          });
        },
      }),
      passkey({
        rpID: rpId,
        rpName: "redc auth lab",
        origin: config.issuer,
      }),
      jwt({
        jwt: {
          issuer: config.issuer,
          audience: config.audience,
          expirationTime: "15m",
        },
      }),
    ],
  });

  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  return {
    auth,
    mailbox,
    runMigrations,
    async getUserByEmail(email: string) {
      const user = await kysely
        .selectFrom("user")
        .select([
          "id",
          "email",
          "onboardingState",
          "recoveryReady",
          "recoveryChallengePending",
          "authAssurance",
          "twoFactorEnabled",
        ])
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      if (!user) {
        return undefined;
      }
      return {
        ...user,
        recoveryReady: Boolean(user.recoveryReady),
        recoveryChallengePending: Boolean(user.recoveryChallengePending),
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
      };
    },
    async enrollRecoveryFactorBySession(sessionId: string, email: string) {
      const session = await kysely
        .selectFrom("session")
        .select(["id", "userId", "sessionKind"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const user = await kysely
        .selectFrom("user")
        .select(["id", "email", "onboardingState"])
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.id !== session.userId) {
        throw new Error(`Session ${sessionId} does not belong to ${email}`);
      }
      const passkey = await kysely
        .selectFrom("passkey")
        .select(["id"])
        .where("userId", "=", user.id)
        .executeTakeFirst();
      if (!passkey) {
        throw new Error(`User ${email} does not have a primary passkey enrolled`);
      }
      if (
        user.onboardingState !== "pending_passkey" &&
        user.onboardingState !== "pending_recovery_factor"
      ) {
        throw new Error(`User ${email} is not ready for recovery-factor enrollment`);
      }

      const secret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const backupCodes = Array.from({ length: 8 }, () =>
        randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(),
      );
      const encryptedSecret = await symmetricEncrypt({
        key: config.secret,
        data: secret,
      });
      const encryptedBackupCodes = await symmetricEncrypt({
        key: config.secret,
        data: JSON.stringify(backupCodes),
      });

      await patchDatabaseRow(kysely, "user", "email", email.trim().toLowerCase(), {
        onboardingState: "pending_recovery_factor",
        recoveryTotpSecretEncrypted: encryptedSecret,
        recoveryBackupCodesEncrypted: encryptedBackupCodes,
        twoFactorEnabled: false,
      });

      return {
        totpURI: createOTP(secret, { digits: 6, period: 30 }).url("redc auth lab", user.email),
        backupCodes,
      };
    },
    async verifyRecoveryFactorBySession(
      sessionId: string,
      email: string,
      input: { code: string; kind?: "totp" | "backup_code" },
    ) {
      const session = await kysely
        .selectFrom("session")
        .select(["id", "userId", "sessionKind"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const user = await kysely
        .selectFrom("user")
        .select([
          "id",
          "email",
          "onboardingState",
          "recoveryTotpSecretEncrypted",
          "recoveryBackupCodesEncrypted",
          "twoFactorEnabled",
        ])
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.id !== session.userId) {
        throw new Error(`Session ${sessionId} does not belong to ${email}`);
      }
      if (
        user.onboardingState !== "pending_recovery_factor" &&
        session.sessionKind !== "recovery_challenge"
      ) {
        throw new Error(`User ${email} is not in a recovery or enrollment flow`);
      }
      if (!user.recoveryTotpSecretEncrypted || !user.recoveryBackupCodesEncrypted) {
        throw new Error(`User ${email} does not have a recovery factor enrolled`);
      }

      const secret = await symmetricDecrypt({
        key: config.secret,
        data: user.recoveryTotpSecretEncrypted,
      });
      const backupCodes = JSON.parse(
        await symmetricDecrypt({
          key: config.secret,
          data: user.recoveryBackupCodesEncrypted,
        }),
      ) as string[];

      let verified = false;
      let remainingBackupCodes = backupCodes;
      if ((input.kind ?? "totp") === "backup_code") {
        const normalized = input.code.trim().toUpperCase();
        const index = backupCodes.indexOf(normalized);
        if (index !== -1) {
          verified = true;
          remainingBackupCodes = backupCodes.filter((_, position) => position !== index);
        }
      } else {
        verified = await createOTP(secret, { digits: 6, period: 30 }).verify(input.code);
      }

      if (!verified) {
        throw new Error(`Recovery factor verification failed`);
      }

      const nextSessionKind =
        session.sessionKind === "recovery_challenge" ? "recovery_challenge" : "active";
      await patchDatabaseRow(kysely, "user", "email", email.trim().toLowerCase(), {
        twoFactorEnabled: true,
        recoveryBackupCodesEncrypted: await symmetricEncrypt({
          key: config.secret,
          data: JSON.stringify(remainingBackupCodes),
        }),
        recoveryChallengePending: false,
      });
      await patchDatabaseRow(kysely, "session", "id", sessionId, {
        sessionKind: nextSessionKind,
        secondFactorVerified: true,
        authPurpose: session.sessionKind === "recovery_challenge" ? "recovery" : "login",
      });

      return { sessionKind: nextSessionKind, secondFactorVerified: true };
    },
    async startRecoveryChallengeByEmail(email: string) {
      const user = await kysely
        .selectFrom("user")
        .select(["id", "email", "onboardingState", "recoveryReady"])
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      if (user.onboardingState !== "active" || !Boolean(user.recoveryReady)) {
        throw new Error(`Active account is required to start recovery`);
      }

      await patchDatabaseRow(kysely, "user", "email", email.trim().toLowerCase(), {
        recoveryChallengePending: true,
      });
    },
    async promoteAccountToActiveBySession(sessionId: string, email: string) {
      const user = await kysely
        .selectFrom("user")
        .select(["id", "email", "twoFactorEnabled", "onboardingState"])
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      if (!user) {
        throw new Error(`User ${email} not found`);
      }
      const passkey = await kysely
        .selectFrom("passkey")
        .select(["id"])
        .where("userId", "=", user.id)
        .executeTakeFirst();
      if (!passkey) {
        throw new Error(`User ${email} does not have a primary passkey enrolled`);
      }
      if (!Boolean(user.twoFactorEnabled)) {
        throw new Error(`User ${email} does not have a verified recovery factor`);
      }
      if (user.onboardingState !== "pending_recovery_factor") {
        throw new Error(`User ${email} is not ready to be activated`);
      }
      await patchDatabaseRow(kysely, "user", "email", email.trim().toLowerCase(), {
        onboardingState: "active",
        recoveryReady: true,
        authAssurance: "passkey+totp",
        recoveryChallengePending: false,
      });
      await patchDatabaseRow(kysely, "session", "id", sessionId, {
        sessionKind: "active",
        secondFactorVerified: true,
        authPurpose: "login",
      });
    },
    async close() {
      await database.close();
    },
  };
}
