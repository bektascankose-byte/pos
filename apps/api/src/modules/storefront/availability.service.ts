import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';

export type OnlineAvailability = 'hidden' | 'pickup_only' | 'delivery_only' | 'pickup_and_delivery';
export type Fulfilment = 'pickup' | 'delivery';

export interface AvailabilityRow {
  variant_id: string;
  store_id: string;
  availability: OnlineAvailability;
  on_hand: string;
  reserved: string;
  safety_stock: string;
  /** What the website may actually sell: on hand, less anything held, less the buffer. Never negative. */
  sellable: string;
}

export interface ListingSettings {
  availability?: OnlineAvailability | undefined;
  safety_stock?: string | undefined;
  max_per_order?: string | undefined;
  online_price_minor?: string | undefined;
  hold_for_pickup?: boolean | undefined;
  hold_for_delivery?: boolean | undefined;
}

/** A line the website wants to sell, checked as a set rather than one at a time. */
export interface RequestedLine {
  variantId: string;
  quantity: string;
}

export type AvailabilityProblem =
  | { variantId: string; reason: 'not_listed' }
  | { variantId: string; reason: 'wrong_fulfilment'; availability: OnlineAvailability }
  | { variantId: string; reason: 'insufficient_stock'; requested: string; sellable: string }
  | { variantId: string; reason: 'over_limit'; requested: string; maxPerOrder: string };

/**
 * What the storefront is allowed to sell, and whether a given cart still is.
 *
 * Every read goes through the `storefront_availability` view rather than
 * recomputing the subtraction here. Three callers need the same answer -- the
 * listing pages, this checker, and the reconciliation report -- and three
 * implementations of one subtraction is how they begin to disagree.
 *
 * Nothing in this service reserves anything. Pickup orders deliberately do not
 * hold stock (see migration 0025), so the protection against selling something
 * the counter is about to sell is `safety_stock`, applied inside the view.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Everything listed for a store, for the catalog pages. */
  async listing(orgId: string, storeId: string, fulfilment?: Fulfilment) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<AvailabilityRow>(
        `SELECT variant_id, store_id, availability,
                on_hand::text, reserved::text, safety_stock::text, sellable::text
         FROM storefront_availability
         WHERE store_id = $1
           AND availability <> 'hidden'
           AND ($2::text IS NULL OR availability = ANY(
                 CASE WHEN $2 = 'pickup'
                      THEN ARRAY['pickup_only','pickup_and_delivery']::online_availability[]
                      ELSE ARRAY['delivery_only','pickup_and_delivery']::online_availability[]
                 END))`,
        [storeId, fulfilment ?? null],
      );
      return rows;
    });
  }

  async forVariant(orgId: string, storeId: string, variantId: string): Promise<AvailabilityRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<AvailabilityRow>(
        `SELECT variant_id, store_id, availability,
                on_hand::text, reserved::text, safety_stock::text, sellable::text
         FROM storefront_availability
         WHERE store_id = $1 AND variant_id = $2`,
        [storeId, variantId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Can this cart still be sold, right now, for this fulfilment type?
   *
   * Returns every problem rather than the first, because a customer whose cart
   * has three issues should be told three times once, not once three times.
   *
   * Called at add-to-cart, at checkout, and again immediately before payment.
   * The last of those is the one that matters: without a hold, stock can move
   * under a cart at any moment, so the only check worth trusting is the one
   * closest to taking the money.
   */
  async check(
    orgId: string,
    storeId: string,
    fulfilment: Fulfilment,
    lines: readonly RequestedLine[],
  ): Promise<AvailabilityProblem[]> {
    if (lines.length === 0) return [];

    return this.db.withOrg(orgId, (tx) => this.checkTx(tx, storeId, fulfilment, lines));
  }

  /**
   * The body of `check`, inside a transaction the caller owns.
   *
   * Order placement needs this: the check and the write have to see the same
   * snapshot, or a cart validated a moment earlier is written against stock
   * that has since gone.
   */
  async checkTx(
    tx: PoolClient,
    storeId: string,
    fulfilment: Fulfilment,
    lines: readonly RequestedLine[],
  ): Promise<AvailabilityProblem[]> {
    const variantIds = lines.map((line) => line.variantId);

    const { rows } = await tx.query<AvailabilityRow & { max_per_order: string | null }>(
      `SELECT a.variant_id, a.store_id, a.availability,
              a.on_hand::text, a.reserved::text, a.safety_stock::text, a.sellable::text,
              l.max_per_order::text
       FROM storefront_availability a
       JOIN storefront_listings l ON l.variant_id = a.variant_id
       WHERE a.store_id = $1 AND a.variant_id = ANY($2::uuid[])`,
      [storeId, variantIds],
    );

    const byVariant = new Map(rows.map((row) => [row.variant_id, row]));
    const problems: AvailabilityProblem[] = [];

    for (const line of lines) {
      const row = byVariant.get(line.variantId);

      // No listing row, or hidden, are the same answer to a customer: this is
      // not something the website sells. They are not distinguished in the
      // reason, because "we have it but won't sell it to you online" is not a
      // useful thing to tell someone.
      if (!row || row.availability === 'hidden') {
        problems.push({ variantId: line.variantId, reason: 'not_listed' });
        continue;
      }

      if (!allows(row.availability, fulfilment)) {
        problems.push({
          variantId: line.variantId,
          reason: 'wrong_fulfilment',
          availability: row.availability,
        });
        continue;
      }

      if (row.max_per_order !== null && compare(line.quantity, row.max_per_order) > 0) {
        problems.push({
          variantId: line.variantId,
          reason: 'over_limit',
          requested: line.quantity,
          maxPerOrder: row.max_per_order,
        });
        continue;
      }

      if (compare(line.quantity, row.sellable) > 0) {
        problems.push({
          variantId: line.variantId,
          reason: 'insufficient_stock',
          requested: line.quantity,
          sellable: row.sellable,
        });
      }
    }

    return problems;
  }

  /**
   * List a variant online, or change how it is listed.
   *
   * Upsert because a listing row is created the moment somebody first decides
   * anything about a product -- there is no separate "create listing" step to
   * forget.
   */
  async setListing(
    orgId: string,
    actorUserId: string,
    variantId: string,
    settings: ListingSettings,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: existing } = await tx.query(
        `SELECT availability, safety_stock::text, max_per_order::text,
                online_price_minor::text, hold_for_pickup, hold_for_delivery
         FROM storefront_listings WHERE variant_id = $1`,
        [variantId],
      );

      const { rows } = await tx.query(
        `INSERT INTO storefront_listings
           (variant_id, org_id, availability, safety_stock, max_per_order,
            online_price_minor, hold_for_pickup, hold_for_delivery, updated_by)
         VALUES ($1, current_setting('app.org_id')::uuid,
                 COALESCE($2::online_availability, 'hidden'),
                 COALESCE($3::numeric, 0), $4::numeric, $5::money_minor,
                 COALESCE($6::boolean, false), COALESCE($7::boolean, false), $8)
         ON CONFLICT (variant_id) DO UPDATE SET
           availability       = COALESCE($2::online_availability, storefront_listings.availability),
           safety_stock       = COALESCE($3::numeric, storefront_listings.safety_stock),
           max_per_order      = COALESCE($4::numeric, storefront_listings.max_per_order),
           online_price_minor = COALESCE($5::money_minor, storefront_listings.online_price_minor),
           hold_for_pickup    = COALESCE($6::boolean, storefront_listings.hold_for_pickup),
           hold_for_delivery  = COALESCE($7::boolean, storefront_listings.hold_for_delivery),
           updated_by         = $8
         RETURNING variant_id, availability, safety_stock::text, max_per_order::text,
                   online_price_minor::text, hold_for_pickup, hold_for_delivery`,
        [
          variantId,
          settings.availability ?? null,
          settings.safety_stock ?? null,
          settings.max_per_order ?? null,
          settings.online_price_minor ?? null,
          settings.hold_for_pickup ?? null,
          settings.hold_for_delivery ?? null,
          actorUserId,
        ],
      );

      // Listing something for sale online is a decision worth being able to
      // date afterwards -- particularly for an age-restricted category.
      await this.audit.record(tx, {
        action: 'storefront.listing.set',
        entityType: 'storefront_listing',
        entityId: variantId,
        actorUserId,
        oldValue: existing[0] ?? null,
        newValue: rows[0],
      });

      return rows[0];
    });
  }

  /**
   * Where the website and the shelf disagree.
   *
   * The fallback the brief asks for behind event-driven sync: a listed item
   * whose figures cannot be trusted should be found by a scheduled job rather
   * than by a customer. Reports rather than corrects -- inventory is a ledger,
   * and a job that silently wrote adjustments would be inventing movements
   * nobody made.
   */
  async reconcile(orgId: string, storeId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        variant_id: string;
        product_name: string;
        sku: string;
        issue: string;
        on_hand: string;
        reserved: string;
        safety_stock: string;
        sellable: string;
      }>(
        `SELECT a.variant_id, p.name AS product_name, v.sku,
                CASE
                  WHEN a.on_hand < 0 THEN 'negative_on_hand'
                  WHEN a.reserved > a.on_hand THEN 'reserved_exceeds_on_hand'
                  WHEN v.status <> 'active' AND a.availability <> 'hidden' THEN 'listed_but_archived'
                  WHEN a.sellable = 0 AND a.on_hand > 0 THEN 'buffer_hides_all_stock'
                  ELSE 'ok'
                END AS issue,
                a.on_hand::text, a.reserved::text, a.safety_stock::text, a.sellable::text
         FROM storefront_availability a
         JOIN product_variants v ON v.id = a.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE a.store_id = $1 AND a.availability <> 'hidden'`,
        [storeId],
      );

      const problems = rows.filter((row) => row.issue !== 'ok');
      return { checked: rows.length, problems };
    });
  }
}

function allows(availability: OnlineAvailability, fulfilment: Fulfilment): boolean {
  if (availability === 'pickup_and_delivery') return true;
  if (fulfilment === 'pickup') return availability === 'pickup_only';
  return availability === 'delivery_only';
}

/**
 * Compare two `numeric(14,3)` values that are travelling as strings.
 *
 * Quantities stay strings end to end in this system so they never pass through
 * a float; comparing them by parsing would reintroduce exactly the problem the
 * convention exists to avoid. Scaled to thousandths and compared as integers,
 * which is exact for every value the column can hold.
 */
export function compare(a: string, b: string): number {
  const scale = (value: string): bigint => {
    const [whole, fraction = ''] = value.trim().replace(/^\+/, '').split('.');
    const negative = whole!.startsWith('-');
    const digits = `${negative ? whole!.slice(1) : whole}${fraction.padEnd(3, '0').slice(0, 3)}`;
    const magnitude = BigInt(digits || '0');
    return negative ? -magnitude : magnitude;
  };
  const left = scale(a);
  const right = scale(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
