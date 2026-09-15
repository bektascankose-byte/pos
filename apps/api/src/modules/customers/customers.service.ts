import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CreateCustomer, CustomerSearch, UpdateCustomer } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const CUSTOMER_COLUMNS = `id, first_name, last_name, phone, email, birth_month, birth_day,
       home_store_id, notes, tags, status, created_at, updated_at`;

@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Find a customer without caching the table on any device.
   *
   * An exact phone match (`phone`) is the register's normal path: a cashier
   * types the number a loyalty program already knows the customer by. `q` is
   * a fragment match against name, email, *and* phone -- the back office's
   * search box is one field, and an admin typing a partial number should not
   * need to know the difference between this parameter and `phone`, which
   * exists for the register's exact-match case specifically. Neither is
   * required: the back office also lists with no filter at all. Plain ILIKE,
   * not trigram ranking -- the customer list per org is small enough that
   * the fuzzy matching product search needs is not worth the complexity
   * pg_trgm brings with it elsewhere in this schema.
   */
  async search(orgId: string, params: CustomerSearch) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${CUSTOMER_COLUMNS}
         FROM customers
         WHERE status = COALESCE($4, 'active')::entity_status AND anonymized_at IS NULL
           AND ($1::text IS NULL OR phone = $1)
           AND ($2::text IS NULL OR
                first_name ILIKE '%' || $2 || '%' OR
                last_name  ILIKE '%' || $2 || '%' OR
                email      ILIKE '%' || $2 || '%' OR
                phone      ILIKE '%' || $2 || '%')
         ORDER BY last_name NULLS LAST, first_name NULLS LAST
         LIMIT $3`,
        [params.phone ?? null, params.q ?? null, params.limit, params.status ?? null],
      );
      return { data: rows, next_cursor: null };
    });
  }

  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1`,
        [id],
      );
      const found = rows[0];
      if (!found) throw ApiException.notFound('customer');
      return found;
    });
  }

  /**
   * A new walk-in, recorded from the register.
   *
   * `customer.manage` gates this route, not `customer.view` -- looking a
   * customer up and creating one are different levels of trust, the same
   * split price override draws between reading a permission and reaching for
   * a manager, and it is enforced by the controller's own guard rather than
   * repeated here.
   */
  async create(orgId: string, actorUserId: string, input: CreateCustomer) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO customers
           (org_id, first_name, last_name, phone, email, birth_month, birth_day,
            home_store_id, notes, tags)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,
                 COALESCE($9::text[], '{}'))
         RETURNING ${CUSTOMER_COLUMNS}`,
        [
          input.first_name ?? null,
          input.last_name ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.birth_month ?? null,
          input.birth_day ?? null,
          input.home_store_id ?? null,
          input.notes ?? null,
          input.tags ?? null,
        ],
      );
      const customer = rows[0]!;

      await this.audit.record(tx, {
        action: 'customer.create',
        entityType: 'customer',
        entityId: customer.id,
        actorUserId,
        newValue: { phone: input.phone, email: input.email },
      });

      return customer;
    });
  }

  /**
   * Edit an existing customer, from the back office.
   *
   * `COALESCE` per column: an omitted field keeps whatever the row already
   * has, so this can never null out both phone and email at once (there is
   * no way to send an explicit clear through this schema) -- which is why,
   * unlike `create`, there is no contactable check here to repeat. Adding a
   * "clear this field" affordance later needs its own schema shape (nullable,
   * not just optional) and its own re-check against `customers_contactable`.
   */
  async update(orgId: string, actorUserId: string, id: string, input: UpdateCustomer) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE customers SET
           first_name   = COALESCE($2, first_name),
           last_name    = COALESCE($3, last_name),
           phone        = COALESCE($4, phone),
           email        = COALESCE($5, email),
           birth_month  = COALESCE($6, birth_month),
           birth_day    = COALESCE($7, birth_day),
           home_store_id = COALESCE($8, home_store_id),
           notes        = COALESCE($9, notes),
           tags         = COALESCE($10::text[], tags),
           status       = COALESCE($11::entity_status, status)
         WHERE id = $1
         RETURNING ${CUSTOMER_COLUMNS}`,
        [
          id,
          input.first_name ?? null,
          input.last_name ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.birth_month ?? null,
          input.birth_day ?? null,
          input.home_store_id ?? null,
          input.notes ?? null,
          input.tags ?? null,
          input.status ?? null,
        ],
      );
      const customer = rows[0];
      if (!customer) throw ApiException.notFound('customer');

      await this.audit.record(tx, {
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        actorUserId,
        newValue: input,
      });

      return customer;
    });
  }

  // ---------------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------------

  /**
   * Where this customer stands on each channel right now.
   *
   * `customer_consents` is an append-only log, so "current" is the most
   * recent event per channel -- `DISTINCT ON` over it ordered by time. A
   * channel with no row at all comes back as `never_asked`, which is
   * deliberately not the same as an explicit `granted: false`: one is a
   * customer who declined and one is a customer nobody ever asked, and only
   * the first is a fact about them. Neither may be sent to.
   */
  async consents(orgId: string, customerId: string) {
    return this.db.withOrg(orgId, (tx) => this.consentsTx(tx, customerId));
  }

  /**
   * Takes the transaction rather than opening one, so `setConsent` can read
   * back the state it just wrote. Opening a second `withOrg` inside an open
   * one takes a different pooled connection, which cannot see the insert the
   * outer transaction has not committed -- the panel came back saying "never
   * asked" immediately after recording an opt-in for exactly that reason.
   */
  private async consentsTx(tx: PoolClient, customerId: string) {
    const { rows } = await tx.query<{
      channel: string;
      granted: boolean;
      source: string;
      occurred_at: string;
    }>(
      `SELECT DISTINCT ON (channel) channel, granted, source, occurred_at
       FROM customer_consents
       WHERE customer_id = $1
       ORDER BY channel, occurred_at DESC`,
      [customerId],
    );

    const byChannel = new Map(rows.map((r) => [r.channel, r]));
    return (['email', 'sms'] as const).map((channel) => {
      const found = byChannel.get(channel);
      return {
        channel,
        granted: found?.granted ?? false,
        source: found?.source ?? null,
        occurred_at: found?.occurred_at ?? null,
        never_asked: !found,
      };
    });
  }

  /** The whole log for one customer, newest first -- what was agreed, when, and on what basis. */
  async consentHistory(orgId: string, customerId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, channel, granted, source, evidence, occurred_at
         FROM customer_consents WHERE customer_id = $1
         ORDER BY occurred_at DESC LIMIT 100`,
        [customerId],
      );
      return rows;
    });
  }

  /**
   * Record a consent event. Always an INSERT -- never an update of an earlier
   * row, and never a delete.
   *
   * Revoking appends `granted: false` rather than removing the grant, because
   * the question a regulator or an angry customer actually asks is "was this
   * person opted in on the day you sent that", and a deleted grant cannot
   * answer it. The log answers it by construction.
   *
   * The employee and their note go into `evidence` alongside the source, so
   * a back-office grant carries who claimed it and on what basis rather than
   * appearing from nowhere.
   */
  async setConsent(
    orgId: string,
    actorUserId: string,
    customerId: string,
    input: { channel: string; granted: boolean; source: string; note?: string | undefined },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: customerRows } = await tx.query<{ id: string; anonymized_at: string | null }>(
        `SELECT id, anonymized_at FROM customers WHERE id = $1`,
        [customerId],
      );
      const customer = customerRows[0];
      if (!customer) throw ApiException.notFound('customer');
      // An anonymized customer has had their identity deliberately erased.
      // Recording a fresh marketing consent against that row would be
      // re-attaching a person to it, which is the one thing anonymizing was
      // meant to prevent.
      if (customer.anonymized_at) {
        throw new ApiException(
          'validation_failed',
          'this customer has been anonymized — consent cannot be recorded against them',
          { retryable: false },
        );
      }

      await tx.query(
        `INSERT INTO customer_consents (org_id, customer_id, channel, granted, source, evidence)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5::jsonb)`,
        [
          customerId,
          input.channel,
          input.granted,
          input.source,
          JSON.stringify({
            recorded_by: actorUserId,
            ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          }),
        ],
      );

      await this.audit.record(tx, {
        action: input.granted ? 'customer.consent_grant' : 'customer.consent_revoke',
        entityType: 'customer',
        entityId: customerId,
        actorUserId,
        newValue: { channel: input.channel, source: input.source, note: input.note ?? null },
      });

      return this.consentsTx(tx, customerId);
    });
  }

  // ---------------------------------------------------------------------------
  // Purchase history
  // ---------------------------------------------------------------------------

  /**
   * What this customer is worth and what they actually buy.
   *
   * `sales_customer_idx (customer_id, completed_at DESC)` has existed since
   * the sales migration and until now nothing read `customer_id` at all --
   * this is the query it was built for.
   *
   * Refunds are netted through `sale_lines.quantity_refunded` rather than by
   * joining the refund tables: it is the one mutable column on a sale line
   * and exists precisely so "what did they keep" is answerable without a
   * second pass. A line refunded in full contributes nothing to the
   * most-bought list, which is the honest answer -- a customer who returned
   * the thing does not want another one.
   */
  async history(orgId: string, customerId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: summaryRows } = await tx.query<{
        visit_count: number;
        lifetime_spend_minor: string;
        first_visit_at: string | null;
        last_visit_at: string | null;
        days_since_last_visit: number | null;
      }>(
        // Lifetime spend is sales minus refunds -- money the shop actually
        // kept. `sales.total_minor` is immutable and a refund is its own row,
        // so summing sales alone would credit a customer for everything they
        // brought back, which is precisely the number not to make a targeting
        // decision on.
        //
        // A refund is theirs if it names them OR if it refunds one of their
        // sales; `DISTINCT` because a refund that does both is still one
        // refund. A visit still counts as a visit even if it was refunded --
        // they came in.
        `WITH their_sales AS (
           SELECT id, total_minor, completed_at
           FROM sales WHERE customer_id = $1 AND status = 'completed'
         ),
         their_refunds AS (
           SELECT DISTINCT r.id, r.total_minor
           FROM refunds r
           WHERE r.customer_id = $1
              OR r.original_sale_id IN (SELECT id FROM their_sales)
         )
         SELECT (SELECT count(*)::int FROM their_sales) AS visit_count,
                ((SELECT COALESCE(sum(total_minor), 0) FROM their_sales)
                 - (SELECT COALESCE(sum(total_minor), 0) FROM their_refunds))::text
                  AS lifetime_spend_minor,
                (SELECT min(completed_at) FROM their_sales) AS first_visit_at,
                (SELECT max(completed_at) FROM their_sales) AS last_visit_at,
                (SELECT date_part('day', now() - max(completed_at))::int FROM their_sales)
                  AS days_since_last_visit`,
        [customerId],
      );
      const summary = summaryRows[0]!;

      const { rows: topProducts } = await tx.query(
        `SELECT p.id AS product_id,
                p.name AS product_name,
                pv.variant_name,
                sum(sl.quantity - sl.quantity_refunded)::text AS quantity,
                -- The line total scaled by the share of it that wasn't sent
                -- back, so a partly refunded line counts for the part kept.
                COALESCE(sum(
                  sl.total_minor
                  * (sl.quantity - sl.quantity_refunded)
                  / NULLIF(sl.quantity, 0)
                ), 0)::bigint::text AS gross_minor,
                max(s.completed_at) AS last_bought_at
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN product_variants pv ON pv.id = sl.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE s.customer_id = $1
           AND s.status = 'completed'
           AND sl.quantity > sl.quantity_refunded
         GROUP BY p.id, p.name, pv.variant_name
         ORDER BY sum(sl.quantity - sl.quantity_refunded) DESC
         LIMIT 10`,
        [customerId],
      );

      const { rows: recentSales } = await tx.query(
        `SELECT s.id, s.receipt_no, s.completed_at, s.total_minor::text,
                (SELECT count(*)::int FROM sale_lines l WHERE l.sale_id = s.id) AS line_count
         FROM sales s
         WHERE s.customer_id = $1 AND s.status = 'completed'
         ORDER BY s.completed_at DESC
         LIMIT 10`,
        [customerId],
      );

      const spend = BigInt(summary.lifetime_spend_minor);
      return {
        ...summary,
        average_ticket_minor:
          summary.visit_count > 0 ? (spend / BigInt(summary.visit_count)).toString() : '0',
        top_products: topProducts,
        recent_sales: recentSales,
      };
    });
  }
}
