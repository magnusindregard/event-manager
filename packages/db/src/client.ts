import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import pg from "pg";
import { v7 } from "uuid";
import { poolConfig } from "./connection.js";
import type { DB } from "./types.js";

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export interface TenantScope {
  tenantId: string;
  userId?: string | null | undefined;
}

/**
 * A node-postgres pool with the environment's auth (Entra tokens and TLS in Azure). Pass it to
 * anything that would otherwise connect with the bare URL, such as graphile-worker.
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool(poolConfig(connectionString, max));
}

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: createPool(connectionString, opts.max ?? 10) }) });
}

/**
 * Runs fn in a transaction scoped to one tenant (ADR 0004). This is the only way
 * request handlers and jobs touch tenant data: RLS policies read app.tenant_id,
 * which is set with is_local = true so it ends with the transaction.
 */
export async function withTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.tenant_id', ${scope.tenantId}, true),
                     set_config('app.user_id', ${scope.userId ?? ""}, true)`.execute(tx);
    return fn(tx);
  });
}

/**
 * Transaction with no tenant set. RLS hides every tenant row, so this is only
 * useful for SECURITY DEFINER functions such as tenancy.login.
 */
export async function withoutTenant<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

/**
 * Picks the database for a tenant. One shared database today; a tenant can be
 * moved to a dedicated one later without touching callers (ADR 0004).
 */
export type DbResolver = (tenantId: string) => Db;
export const singleDb = (db: Db): DbResolver => () => db;

/** Time-ordered UUIDs (v7). IDs are never reused. */
export const newId = (): string => v7();
