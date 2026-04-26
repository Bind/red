import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt, magicLink } from "better-auth/plugins";
import type { QueryExecutorProvider } from "kysely";
import { sql } from "kysely";
import { createLoginAttemptStore, type LoginAttemptStore } from "../store/login-attempt-store";
import { createSessionStore, type SessionStore } from "../store/session-store";
import { createUserStore, type UserStore } from "../store/user-store";
import type { UserMagicLinkPurpose } from "../util/types";
import type { BetterAuthSessionResult } from "./better-auth-adapter";
import { type AuthDatabaseKind, createAuthDatabase } from "./db/auth-db";

type CustomColumnBuilder = {
  primaryKey(): CustomColumnBuilder;
  notNull(): CustomColumnBuilder;
};

type CustomTableBuilder = {
  ifNotExists(): CustomTableBuilder;
  addColumn(
    name: string,
    dataType: string,
    configure?: (column: CustomColumnBuilder) => CustomColumnBuilder,
  ): CustomTableBuilder;
  execute(): Promise<void>;
};

type SchemaCapableDb = {
  schema?: {
    createTable(name: string): CustomTableBuilder;
  };
} & QueryExecutorProvider;

type BetterAuthWithSchemaDb = {
  options?: {
    database?: {
      db?: SchemaCapableDb;
    };
  };
};

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
  passkeyOrigins: string[];
  passkeyRpId: string;
  database: UserAuthRuntimeDatabaseConfig;
}

export interface UserAuthRuntime {
  auth: UserAuthRuntimeAuth;
  mailbox: MagicLinkMail[];
  stores: {
    user: UserStore;
    session: SessionStore;
    loginAttempt: LoginAttemptStore;
  };
  database: {
    kind: AuthDatabaseKind;
    ping(): Promise<void>;
  };
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}

async function ensureCustomTables(auth: BetterAuthWithSchemaDb) {
  const db = auth.options?.database?.db;
  if (!db || typeof db.schema?.createTable !== "function") {
    return;
  }

  await db.schema
    .createTable("login_attempt")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("email", "text", (column) => column.notNull())
    .addColumn("clientId", "text", (column) => column.notNull())
    .addColumn("purpose", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("magicLinkTokenHash", "text")
    .addColumn("loginGrantHash", "text")
    .addColumn("loginGrantEncrypted", "text")
    .addColumn("completedSessionId", "text")
    .addColumn("completedSetCookieEncrypted", "text")
    .addColumn("expiresAt", "text", (column) => column.notNull())
    .addColumn("completedAt", "text")
    .addColumn("redeemedAt", "text")
    .addColumn("createdAt", "text", (column) => column.notNull())
    .addColumn("updatedAt", "text", (column) => column.notNull())
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempt_email ON login_attempt(email)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempt_status ON login_attempt(status)`.execute(
    db,
  );
}

export async function createUserAuthRuntime(
  config: UserAuthRuntimeConfig,
): Promise<UserAuthRuntime> {
  const mailbox: MagicLinkMail[] = [];
  if (config.passkeyOrigins.length === 0) {
    throw new Error("At least one passkey origin must be configured");
  }
  const database = await createAuthDatabase(config.database);
  const { kysely } = database;
  const userStore = createUserStore(kysely);
  const sessionStore = createSessionStore(kysely);
  const loginAttemptStore = createLoginAttemptStore(kysely);

  const auth = betterAuth({
    appName: "red-auth-lab",
    baseURL: config.issuer,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: config.passkeyOrigins,
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
        rpID: config.passkeyRpId,
        rpName: "red auth lab",
        origin:
          config.passkeyOrigins.length === 1 ? config.passkeyOrigins[0] : config.passkeyOrigins,
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
  await ensureCustomTables(auth as BetterAuthWithSchemaDb);

  return {
    auth: auth as unknown as UserAuthRuntimeAuth,
    mailbox,
    stores: {
      user: userStore,
      session: sessionStore,
      loginAttempt: loginAttemptStore,
    },
    database: {
      kind: database.kind,
      ping: () => database.ping(),
    },
    runMigrations,
    async close() {
      await database.close();
    },
  };
}
