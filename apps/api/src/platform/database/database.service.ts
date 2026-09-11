import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

/**
 * The one place that holds a connection to Postgres.
 *
 * Two rules this service exists to enforce, both of which are easy to break by
 * accident and expensive to discover later:
 *
 * 1. The pool connects as `snappos_app`, never as the table owner. RLS does not
 *    apply to an owner, so connecting as `snappos_migrator` would silently turn
 *    every tenancy policy into decoration. Checked at boot rather than trusted.
 *
 * 2. Every query runs inside a transaction that has set `app.org_id`. The
 *    policies deny when it is unset, so a forgotten context is an empty result
 *    rather than another tenant's data. That is the right failure direction,
 *    but an empty result is still confusing, so `withOrg` makes setting it the
 *    only convenient path.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  async onModuleInit(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // A register waiting on a query is a cashier waiting at a counter.
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),
    });

    this.pool.on('error', (err) => {
      // An idle client erroring is usually the server restarting. Log it and
      // let the pool replace the connection rather than crashing the process.
      this.logger.error({ err: err.message }, 'idle database client error');
    });

    await this.assertNotTableOwner();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Refuse to start if the API is connected as a role that bypasses RLS.
   *
   * This is a boot check and not a test because the failure is silent and total:
   * everything works, every query returns data, and tenant isolation is simply
   * gone. Far better to not start.
   */
  private async assertNotTableOwner(): Promise<void> {
    const { rows } = await this.pool.query<{
      role: string;
      is_super: boolean;
      bypasses_rls: boolean;
      owns_tables: number;
    }>(`
      SELECT current_user                                   AS role,
             r.rolsuper                                     AS is_super,
             r.rolbypassrls                                 AS bypasses_rls,
             (SELECT count(*)::int FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r'
                AND c.relowner = current_user::regrole)     AS owns_tables
      FROM pg_roles r WHERE r.rolname = current_user
    `);

    const info = rows[0];
    if (!info) throw new Error('could not determine the current database role');

    const problems: string[] = [];
    if (info.is_super) problems.push('is a superuser');
    if (info.bypasses_rls) problems.push('has BYPASSRLS');
    if (info.owns_tables > 0) problems.push(`owns ${info.owns_tables} tables`);

    if (problems.length > 0) {
      throw new Error(
        `The API is connected as "${info.role}", which ${problems.join(' and ')}. ` +
          `Row level security does not apply, so every tenancy policy is inert. ` +
          `Point DATABASE_URL at snappos_app. See packages/db/scripts/bootstrap-roles.sql.`,
      );
    }

    this.logger.log(`connected as ${info.role} (not an owner, RLS enforced)`);
  }

  /**
   * Run work inside a transaction scoped to one organization.
   *
   * `SET LOCAL` is deliberate: it is scoped to the transaction and reverts on
   * commit or rollback, so a pooled connection cannot carry one request's org
   * context into the next. A plain `SET` here would be a cross-tenant data leak
   * that only appears under load.
   */
  async withOrg<T>(orgId: string, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Parameterized, because orgId reaching a SET statement by interpolation
      // would be an injection point on the one value that gates every row.
      await client.query('SELECT set_config($1, $2, true)', ['app.org_id', orgId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * For the few queries that legitimately have no organization: the login
   * lookup, health checks, and platform level reference data. Everything else
   * belongs in `withOrg`.
   */
  async unscoped<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
