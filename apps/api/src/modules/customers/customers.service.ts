import { Injectable } from '@nestjs/common';
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
         WHERE status = 'active' AND anonymized_at IS NULL
           AND ($1::text IS NULL OR phone = $1)
           AND ($2::text IS NULL OR
                first_name ILIKE '%' || $2 || '%' OR
                last_name  ILIKE '%' || $2 || '%' OR
                email      ILIKE '%' || $2 || '%' OR
                phone      ILIKE '%' || $2 || '%')
         ORDER BY last_name NULLS LAST, first_name NULLS LAST
         LIMIT $3`,
        [params.phone ?? null, params.q ?? null, params.limit],
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
            home_store_id, notes)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8)
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
           notes        = COALESCE($9, notes)
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
}
