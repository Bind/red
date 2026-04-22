import type { Database } from "bun:sqlite";
import {
  CompiledQuery,
  DEFAULT_MIGRATION_LOCK_TABLE,
  DEFAULT_MIGRATION_TABLE,
  DefaultQueryCompiler,
  sql,
} from "kysely";

type BunSqliteDialectConfig = {
  database: Database;
  onCreateConnection?: (connection: unknown) => Promise<void> | void;
};

type BunSqliteStatement = {
  all(...parameters: readonly unknown[]): unknown[];
};

type TransactionConnection = {
  executeQuery(compiledQuery: CompiledQuery): Promise<unknown>;
};

type IntrospectionDb = {
  selectFrom(table: unknown): any;
};

type TableColumnMetadata = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
};

class BunSqliteAdapter {
  get supportsCreateIfNotExists() {
    return true;
  }

  get supportsTransactionalDdl() {
    return false;
  }

  get supportsReturning() {
    return true;
  }

  async acquireMigrationLock() {}

  async releaseMigrationLock() {}

  get supportsOutput() {
    return true;
  }
}

class BunSqliteConnection {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  executeQuery(compiledQuery: CompiledQuery) {
    const statement = this.#db.prepare(compiledQuery.sql) as BunSqliteStatement;
    return Promise.resolve({
      rows: statement.all(...compiledQuery.parameters),
    });
  }

  async *streamQuery() {
    yield undefined as never;
    throw new Error("Streaming query is not supported by the Bun SQLite driver.");
  }
}

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock() {
    while (this.#promise) {
      await this.#promise;
    }
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock() {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}

class BunSqliteDriver {
  #config: BunSqliteDialectConfig;
  #connectionMutex = new ConnectionMutex();
  #db: Database | undefined;
  #connection: BunSqliteConnection | undefined;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = { ...config };
  }

  async init() {
    this.#db = this.#config.database as Database;
    this.#connection = new BunSqliteConnection(this.#db);
    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(this.#connection);
    }
  }

  async acquireConnection() {
    await this.#connectionMutex.lock();
    return this.#connection as never;
  }

  async beginTransaction(connection: TransactionConnection) {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: TransactionConnection) {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: TransactionConnection) {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection() {
    this.#connectionMutex.unlock();
  }

  async destroy() {
    this.#db?.close();
  }
}

class BunSqliteIntrospector {
  #db: IntrospectionDb;

  constructor(db: IntrospectionDb) {
    this.#db = db;
  }

  async getSchemas() {
    return [];
  }

  async getTables(options = { withInternalKyselyTables: false }) {
    let query = this.#db
      .selectFrom("sqlite_schema")
      .where("type", "=", "table")
      .where("name", "not like", "sqlite_%")
      .select("name");

    if (!options.withInternalKyselyTables) {
      query = query
        .where("name", "!=", DEFAULT_MIGRATION_TABLE)
        .where("name", "!=", DEFAULT_MIGRATION_LOCK_TABLE);
    }

    const tables = await query.execute();
    return Promise.all(tables.map(({ name }: { name: string }) => this.#getTableMetadata(name)));
  }

  async getMetadata(options?: { withInternalKyselyTables?: boolean }) {
    return {
      tables: await this.getTables({
        withInternalKyselyTables: options?.withInternalKyselyTables ?? false,
      }),
    };
  }

  async #getTableMetadata(table: string) {
    const db = this.#db as any;
    const autoIncrementCol = (
      await db
        .selectFrom("sqlite_master")
        .where("name", "=", table)
        .select("sql")
        .$castTo()
        .execute()
    )[0]?.sql
      ?.split(/[(),]/)
      ?.find((item: string) => item.toLowerCase().includes("autoincrement"))
      ?.split(/\s+/)?.[0]
      ?.replace(/["`]/g, "");

    const columns = await db
      .selectFrom(sql`pragma_table_info(${table})`.as("table_info"))
      .select(["name", "type", "notnull", "dflt_value"])
      .execute();

    return {
      name: table,
      columns: (columns as TableColumnMetadata[]).map((column) => ({
        name: column.name,
        dataType: column.type,
        isNullable: !column.notnull,
        isAutoIncrementing: column.name === autoIncrementCol,
        hasDefaultValue: column.dflt_value != null,
      })),
      isView: true,
    };
  }
}

class BunSqliteQueryCompiler extends DefaultQueryCompiler {
  protected override getCurrentParameterPlaceholder() {
    return "?";
  }

  protected override getLeftIdentifierWrapper() {
    return '"';
  }

  protected override getRightIdentifierWrapper() {
    return '"';
  }

  protected override getAutoIncrement() {
    return "autoincrement";
  }
}

export class BunSqliteDialect {
  #config: BunSqliteDialectConfig;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = { ...config };
  }

  createDriver() {
    return new BunSqliteDriver(this.#config);
  }

  createQueryCompiler() {
    return new BunSqliteQueryCompiler();
  }

  createAdapter() {
    return new BunSqliteAdapter();
  }

  createIntrospector(db: IntrospectionDb) {
    return new BunSqliteIntrospector(db);
  }
}
