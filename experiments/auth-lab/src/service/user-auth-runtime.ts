import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt, magicLink } from "better-auth/plugins";
import { createSessionStore, type SessionStore } from "../store/session-store";
import { createUserStore, type UserStore } from "../store/user-store";
import type { UserMagicLinkPurpose } from "../util/types";
import type { BetterAuthSessionResult } from "./better-auth-adapter";
import { type AuthDatabaseKind, createAuthDatabase } from "./db/auth-db";

export interface UserAuthRuntimeAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers; returnHeaders: true }): Promise<BetterAuthSessionResult>;
  };
}

export interface MagicLinkMail {
  email: string;
  token: string;
  url: string;
  purpose: UserMagicLinkPurpose | "unknown";
}

export interface UserAuthRuntimeDatabaseConfig {
  kind: AuthDatabaseKind;
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

export interface UserAuthRuntime {
  auth: UserAuthRuntimeAuth;
  mailbox: MagicLinkMail[];
  stores: {
    user: UserStore;
    session: SessionStore;
  };
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}

export async function createUserAuthRuntime(
  config: UserAuthRuntimeConfig,
): Promise<UserAuthRuntime> {
  const mailbox: MagicLinkMail[] = [];
  const rpId = new URL(config.issuer).hostname;
  const database = await createAuthDatabase(config.database);
  const { kysely } = database;
  const userStore = createUserStore(kysely);
  const sessionStore = createSessionStore(kysely);

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
    auth: auth as unknown as UserAuthRuntimeAuth,
    mailbox,
    stores: {
      user: userStore,
      session: sessionStore,
    },
    runMigrations,
    async close() {
      await database.close();
    },
  };
}
