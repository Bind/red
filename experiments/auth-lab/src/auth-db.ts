import { Database } from "bun:sqlite";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { BunSqliteDialect } from "./bun-sqlite-dialect";

export type AuthLabDatabaseKind = "sqlite" | "postgres";

export interface AuthLabDatabaseConfig {
  kind: AuthLabDatabaseKind;
  sqlitePath?: string;
  postgresUrl?: string;
}

export interface AuthLabDatabase {
  kysely: Kysely<any>;
  kind: AuthLabDatabaseKind;
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

async function getSqliteTables(db: Kysely<any>): Promise<TableMetadata[]> {
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

async function getPostgresTables(db: Kysely<any>): Promise<TableMetadata[]> {
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

export async function createAuthLabDatabase(
  config: AuthLabDatabaseConfig,
): Promise<AuthLabDatabase> {
  if (config.kind === "sqlite") {
    const database = new Database(config.sqlitePath ?? ":memory:");
    const kysely = new Kysely({
      dialect: new BunSqliteDialect({ database: database as any }) as any,
    });

    Object.defineProperty(kysely as any, "introspection", {
      value: {
        async getTables() {
          return getSqliteTables(kysely);
        },
      },
    });

    return {
      kind: "sqlite",
      kysely,
      async close() {
        kysely.destroy();
        database.close();
      },
    };
  }

  const pool = new Pool({
    connectionString: config.postgresUrl,
  });
  const kysely = new Kysely({
    dialect: new PostgresDialect({ pool }),
  });

  Object.defineProperty(kysely as any, "introspection", {
    value: {
      async getTables() {
        return getPostgresTables(kysely);
      },
    },
  });

  return {
    kind: "postgres",
    kysely,
    async close() {
      kysely.destroy();
      await pool.end();
    },
  };
}

export async function patchDatabaseRow(
  db: Kysely<any>,
  table: string,
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
