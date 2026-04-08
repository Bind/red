import { Database } from "bun:sqlite";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { BunSqliteDialect } from "./bun-sqlite-dialect";

export type AuthDatabaseKind = "sqlite" | "postgres";

export interface AuthDatabaseConfig {
  kind: AuthDatabaseKind;
  sqlitePath?: string;
  postgresUrl?: string;
}

export interface AuthUserRow {
  id: string;
  email: string;
  onboardingState?: string | null;
  recoveryReady?: boolean | null;
  recoveryChallengePending?: boolean | null;
  authAssurance?: string | null;
  twoFactorEnabled?: boolean | null;
  recoveryTotpSecretEncrypted?: string | null;
  recoveryBackupCodesEncrypted?: string | null;
}

export interface AuthSessionRow {
  id: string;
  userId: string;
  sessionKind?: string | null;
  authPurpose?: string | null;
  secondFactorVerified?: boolean | null;
}

export interface AuthPasskeyRow {
  id: string;
  userId: string;
}

export interface AuthLoginAttemptRow {
  id: string;
  email: string;
  clientId: string;
  purpose: string;
  status: string;
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

export interface AuthDatabaseSchema {
  user: AuthUserRow;
  session: AuthSessionRow;
  passkey: AuthPasskeyRow;
  login_attempt: AuthLoginAttemptRow;
}

export interface AuthDatabase {
  kysely: Kysely<AuthDatabaseSchema>;
  kind: AuthDatabaseKind;
  ping(): Promise<void>;
  close(): Promise<void>;
}

type TableColumn = {
  name: string;
  dataType: string;
};

type TableMetadata = {
  name: string;
  schema: string;
  columns: TableColumn[];
};

async function getSqliteTables(db: Kysely<AuthDatabaseSchema>): Promise<TableMetadata[]> {
  const tables = await sql<{ name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `.execute(db);

  const metadata: TableMetadata[] = [];
  for (const table of tables.rows) {
    const columns = await sql<{ name: string; type: string }>`
      PRAGMA table_info(${table.name})
    `.execute(db);

    metadata.push({
      name: table.name,
      schema: "main",
      columns: columns.rows.map((column) => ({
        name: column.name,
        dataType: column.type || "TEXT",
      })),
    });
  }

  return metadata;
}

async function getPostgresTables(db: Kysely<AuthDatabaseSchema>): Promise<TableMetadata[]> {
  const tables = await sql<{ table_name: string; table_schema: string }>`
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `.execute(db);

  const metadata: TableMetadata[] = [];
  for (const table of tables.rows) {
    const columns = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = ${table.table_schema}
        AND table_name = ${table.table_name}
      ORDER BY ordinal_position
    `.execute(db);

    metadata.push({
      name: table.table_name,
      schema: table.table_schema,
      columns: columns.rows.map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
      })),
    });
  }

  return metadata;
}

export async function createAuthDatabase(config: AuthDatabaseConfig): Promise<AuthDatabase> {
  if (config.kind === "sqlite") {
    const database = new Database(config.sqlitePath ?? ":memory:");
    const kysely = new Kysely<AuthDatabaseSchema>({
      dialect: new BunSqliteDialect({ database: database as unknown as Database }) as never,
    }) as Kysely<AuthDatabaseSchema> & {
      introspection: {
        getTables(): Promise<TableMetadata[]>;
      };
    };

    Object.defineProperty(kysely, "introspection", {
      value: {
        async getTables() {
          return getSqliteTables(kysely);
        },
      },
    });

    return {
      kind: "sqlite",
      kysely,
      async ping() {
        await sql`SELECT 1 AS ok`.execute(kysely);
      },
      async close() {
        kysely.destroy();
        database.close();
      },
    };
  }

  const pool = new Pool({
    connectionString: config.postgresUrl,
  });
  const kysely = new Kysely<AuthDatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  }) as Kysely<AuthDatabaseSchema> & {
    introspection: {
      getTables(): Promise<TableMetadata[]>;
    };
  };

  Object.defineProperty(kysely, "introspection", {
    value: {
      async getTables() {
        return getPostgresTables(kysely);
      },
    },
  });

  return {
    kind: "postgres",
    kysely,
    async ping() {
      await sql`SELECT 1 AS ok`.execute(kysely);
    },
    async close() {
      kysely.destroy();
      await pool.end();
    },
  };
}

export async function patchDatabaseRow(
  db: Kysely<AuthDatabaseSchema>,
  table: keyof AuthDatabaseSchema,
  keyColumn: string,
  keyValue: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }

  await db
    .updateTable(table)
    .set(Object.fromEntries(entries) as Record<string, unknown>)
    .where(keyColumn as never, "=", keyValue as never)
    .execute();
}
