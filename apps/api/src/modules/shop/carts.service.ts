import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import {
  deliveryFeeFor,
  deliveryRefusal,
  money,
  pointsForBasis,
  taxForCharge,
  taxForLine,
  type ChargeLine,
  type OrderFulfilment,
  type ShopCart,
  type ShopCartCreated,
  type ShopCartLine,
  type ShopSetFulfilment,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';
import { taxRatesByCategory } from '../orders/order-tax.js';
import { DeliverySettingsService } from '../delivery/delivery-settings.service.js';
import { hashSecret, type CustomerSession } from './customer-sessions.service.js';
import { ShopCatalogService, wholeUnits } from './shop-catalog.service.js';

const CART_DAYS = 30;
const MAX_LINES = 50;
const MAX_QUANTITY = 99;

export interface LockedCart {
  id: string;
  store_id: string;
  customer_id: string | null;
  converted_order_id: string | null;
  fulfilment: OrderFulfilment;
  delivery_postal_code: string | null;
}

interface LiveLine {
  variant_id: string;
  quantity: number;
  product_id: string | null;
  product_name: string | null;
  variant_name: string | null;
  image_id: string | null;
  price_minor: string | null;
  availability: string | null;
  sellable: string | null;
  max_per_order: string | null;
  tax_category_id: string | null;
  minimum_age: number | null;
  id_required: boolean | null;
  regulated_class: string | null;
  active: boolean;
}

const LISTED_FOR: Record<OrderFulfilment, readonly string[]> = {
  pickup: ['pickup_only', 'pickup_and_delivery'],
  delivery: ['delivery_only', 'pickup_and_delivery'],
};

/**
 * Shopping carts.
 *
 * A cart stores what was chosen, how many, and whether it is for pickup or
 * delivery -- and nothing that can go stale: no price, no stock figure, no
 * "allowed" flag, no fee. Every read works those out again from the catalog,
 * the shelf, the rules and the delivery terms as they are at that moment, and
 * puts any problem where it belongs, in words the shopper can act on. The same
 * checks run once more inside checkout, because a cart that was fine a minute
 * ago is not a promise.
 */
@Injectable()
export class CartsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly catalog: ShopCatalogService,
    private readonly delivery: DeliverySettingsService,
  ) {}

  async create(shop: ShopClient, session: CustomerSession | null): Promise<ShopCartCreated> {
    const token = randomBytes(32).toString('base64url');
    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<LockedCart>(
        `INSERT INTO carts (org_id, store_id, token_hash, customer_id, expires_at)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, now() + make_interval(days => $4))
         RETURNING id, store_id, customer_id, converted_order_id, fulfilment, delivery_postal_code`,
        [shop.storeId, hashSecret(token), session?.customerId ?? null, CART_DAYS],
      );
      return { cart_token: token, cart: await this.viewTx(tx, rows[0]!, session) };
    });
  }

  async get(shop: ShopClient, token: string | undefined, session: CustomerSession | null): Promise<ShopCart> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const cart = await this.lockTx(tx, shop, token);
      await this.claimTx(tx, cart, session);
      return this.viewTx(tx, cart, session);
    });
  }

  /**
   * Switch between pickup and delivery, and say where a delivery is going.
   *
   * The lines stay as they are: an item that can be picked up but not
   * delivered is flagged on its line rather than silently dropped, so the
   * shopper decides what to do about it.
   */
  async setFulfilment(
    shop: ShopClient,
    token: string | undefined,
    session: CustomerSession | null,
    input: ShopSetFulfilment,
  ): Promise<ShopCart> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const cart = await this.lockTx(tx, shop, token);
      await this.claimTx(tx, cart, session);

      if (input.fulfilment === 'delivery') {
        const offer = await this.delivery.offerTx(tx, cart.store_id);
        if (!offer.offered) {
          throw new ApiException('conflict', "Delivery isn't available right now. Pickup is.", { retryable: false });
        }
      }

      await tx.query(
        `UPDATE carts SET fulfilment = $2, delivery_postal_code = COALESCE($3, delivery_postal_code) WHERE id = $1`,
        [cart.id, input.fulfilment, input.postal_code ?? null],
      );
      cart.fulfilment = input.fulfilment;
      if (input.postal_code) cart.delivery_postal_code = input.postal_code;
      await this.touchTx(tx, cart);
      return this.viewTx(tx, cart, session);
    });
  }

  /** Set a line to exactly this many. Zero removes it. */
  async setLine(
    shop: ShopClient,
    token: string | undefined,
    session: CustomerSession | null,
    variantId: string,
    quantity: number,
  ): Promise<ShopCart> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const cart = await this.lockTx(tx, shop, token);
      await this.claimTx(tx, cart, session);
      await this.writeLineTx(tx, cart, variantId, quantity);
      return this.viewTx(tx, cart, session);
    });
  }

  /** Add this many to whatever is already there. */
  async addToLine(
    shop: ShopClient,
    token: string | undefined,
    session: CustomerSession | null,
    variantId: string,
    quantity: number,
  ): Promise<ShopCart> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const cart = await this.lockTx(tx, shop, token);
      await this.claimTx(tx, cart, session);
      const { rows } = await tx.query<{ quantity: string }>(
        `SELECT quantity::text FROM cart_lines WHERE cart_id = $1 AND variant_id = $2`,
        [cart.id, variantId],
      );
      const current = rows[0] ? wholeUnits(rows[0].quantity) : 0;
      await this.writeLineTx(tx, cart, variantId, current + quantity);
      return this.viewTx(tx, cart, session);
    });
  }

  /**
   * The cart a token names, locked, or a not-found that tells the storefront to
   * start a new one. A cart that became an order, or that nobody touched for a
   * month, is gone as far as a shopper is concerned.
   */
  async lockTx(tx: PoolClient, shop: ShopClient, token: string | undefined): Promise<LockedCart> {
    if (!token || token.length < 20 || token.length > 200) throw ApiException.notFound('cart');
    const { rows } = await tx.query<LockedCart>(
      `SELECT id, store_id, customer_id, converted_order_id, fulfilment, delivery_postal_code FROM carts
       WHERE token_hash = $1 AND store_id = $2 AND expires_at > now()
       FOR UPDATE`,
      [hashSecret(token), shop.storeId],
    );
    const cart = rows[0];
    if (!cart) throw ApiException.notFound('cart');
    return cart;
  }

  /** The lines as checkout needs them: variant and quantity, nothing else. */
  async linesTx(tx: PoolClient, cartId: string): Promise<{ variant_id: string; quantity: string }[]> {
    const { rows } = await tx.query<{ variant_id: string; quantity: string }>(
      `SELECT variant_id, quantity::text FROM cart_lines WHERE cart_id = $1 ORDER BY created_at`,
      [cartId],
    );
    return rows;
  }

  /** What the cart holds, priced, taxed and checked as of now, for the way it will be fulfilled. */
  async viewTx(tx: PoolClient, cart: LockedCart, session: CustomerSession | null = null): Promise<ShopCart> {
    const empty: ShopCart = {
      fulfilment: cart.fulfilment,
      delivery_postal_code: cart.delivery_postal_code,
      lines: [],
      item_count: 0,
      subtotal_minor: '0',
      delivery_fee_minor: '0',
      estimated_tax_minor: '0',
      estimated_total_minor: '0',
      delivery_problem: null,
      can_checkout: false,
      minimum_age: null,
      id_required: false,
      points_to_earn: null,
    };

    const { rows } = await tx.query<LiveLine>(
      `SELECT cl.variant_id, floor(cl.quantity)::int AS quantity,
              p.id AS product_id, p.name AS product_name, v.variant_name,
              COALESCE(
                (SELECT i.id FROM product_images i WHERE i.variant_id = v.id ORDER BY i.sort_order, i.created_at LIMIT 1),
                (SELECT i.id FROM product_images i WHERE i.product_id = p.id
                  ORDER BY (i.variant_id IS NULL) DESC, i.sort_order, i.created_at LIMIT 1)
              ) AS image_id,
              COALESCE(l.online_price_minor, pr.price_minor)::text AS price_minor,
              l.availability::text AS availability,
              a.sellable::text AS sellable,
              l.max_per_order::text AS max_per_order,
              p.tax_category_id,
              pc.minimum_age,
              pc.id_scan_required AS id_required,
              pc.regulated_class,
              (v.status = 'active' AND p.status = 'active') AS active
       FROM cart_lines cl
       JOIN product_variants v ON v.id = cl.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN storefront_listings l ON l.variant_id = v.id
       LEFT JOIN storefront_availability a ON a.variant_id = v.id AND a.store_id = $2
       LEFT JOIN product_compliance pc ON pc.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT price_minor FROM variant_prices
         WHERE variant_id = v.id AND (store_id = $2 OR store_id IS NULL)
           AND kind = 'regular' AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY store_id NULLS LAST, effective_from DESC LIMIT 1
       ) pr ON true
       WHERE cl.cart_id = $1
       ORDER BY cl.created_at`,
      [cart.id, cart.store_id],
    );

    if (rows.length === 0) return empty;

    const fulfilment = cart.fulfilment;
    const decisions = await this.catalog.decisions(
      tx,
      cart.store_id,
      rows.map((row) => row.variant_id),
      fulfilment,
    );
    const rates = await taxRatesByCategory(tx, cart.store_id, fulfilment);
    const how = fulfilment === 'delivery' ? 'for delivery' : 'for pickup';

    let subtotal = 0n;
    let tax = 0n;
    let minimumAge: number | null = null;
    let idRequired = false;
    const chargeLines: ChargeLine[] = [];
    const classes: { amount: bigint; regulatedClass: string | null }[] = [];

    const lines: ShopCartLine[] = rows.map((row) => {
      const decision = decisions.get(row.variant_id);
      const sellable = row.sellable === null ? 0 : wholeUnits(row.sellable);
      const limit = row.max_per_order === null ? MAX_QUANTITY : Math.min(wholeUnits(row.max_per_order), MAX_QUANTITY);
      const listedAnywhere = row.active && row.price_minor !== null && row.availability !== null && row.availability !== 'hidden';
      const listedHere = listedAnywhere && LISTED_FOR[fulfilment].includes(row.availability!);

      let problem: ShopCartLine['problem'] = null;
      let message: string | null = null;
      if (!listedAnywhere) {
        problem = 'not_available';
        message = 'No longer available online. Remove it to continue.';
      } else if (!listedHere) {
        problem = 'not_available';
        message = `Not available ${how}. Remove it, or switch to ${fulfilment === 'delivery' ? 'pickup' : 'delivery'}.`;
      } else if (!decision?.allowed) {
        problem = 'not_allowed';
        message = `Can't be ordered online ${how}. Remove it to continue.`;
      } else if (sellable < 1) {
        problem = 'out_of_stock';
        message = 'Out of stock. Remove it to continue.';
      } else if (row.quantity > sellable) {
        problem = 'not_enough_stock';
        message = `Only ${sellable} left. Lower the quantity to continue.`;
      } else if (row.quantity > limit) {
        problem = 'over_limit';
        message = `Limit ${limit} per order. Lower the quantity to continue.`;
      }

      const lineTotal = row.price_minor === null ? null : BigInt(row.price_minor) * BigInt(row.quantity);
      if (lineTotal !== null) {
        const lineRates = rates.get(row.tax_category_id ?? '') ?? [];
        subtotal += lineTotal;
        tax += taxForLine(money(lineTotal), lineRates).tax;
        chargeLines.push({ amount: money(lineTotal), rates: lineRates });
        classes.push({ amount: lineTotal, regulatedClass: row.regulated_class });
      }

      const age = Math.max(decision?.minimumAge ?? 0, row.minimum_age ?? 0);
      if (age > 0) minimumAge = Math.max(minimumAge ?? 0, age);
      idRequired = idRequired || Boolean(row.id_required) || Boolean(decision?.requiresIdScan);

      return {
        variant_id: row.variant_id,
        product_id: row.product_id!,
        product_name: row.product_name ?? '',
        variant_name: row.variant_name,
        image_id: row.image_id,
        quantity: row.quantity,
        unit_price_minor: row.price_minor,
        line_total_minor: lineTotal === null ? null : lineTotal.toString(),
        problem,
        problem_message: message,
        max_quantity: Math.max(Math.min(limit, sellable), 0),
      };
    });

    let fee = 0n;
    let deliveryProblem: string | null = null;
    if (fulfilment === 'delivery') {
      const offer = await this.delivery.offerTx(tx, cart.store_id);
      if (!offer.offered) {
        deliveryProblem = "Delivery isn't available right now. Switch to pickup to continue.";
      } else {
        deliveryProblem = deliveryRefusal(offer.terms, cart.delivery_postal_code, subtotal);
        fee = deliveryFeeFor(offer.terms, subtotal);
        tax += taxForCharge(money(fee), chargeLines).tax;
      }
    }

    return {
      fulfilment,
      delivery_postal_code: cart.delivery_postal_code,
      lines,
      item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotal_minor: subtotal.toString(),
      delivery_fee_minor: fee.toString(),
      estimated_tax_minor: tax.toString(),
      estimated_total_minor: (subtotal + fee + tax).toString(),
      delivery_problem: deliveryProblem,
      can_checkout: deliveryProblem === null && lines.every((line) => line.problem === null),
      minimum_age: minimumAge,
      id_required: idRequired,
      points_to_earn: session ? await this.pointsEstimateTx(tx, classes) : null,
    };
  }

  /** Roughly what this cart will earn, by the program's rules as they stand. Null with no program running. */
  private async pointsEstimateTx(
    tx: PoolClient,
    lines: readonly { amount: bigint; regulatedClass: string | null }[],
  ): Promise<number | null> {
    const { rows } = await tx.query<{ is_active: boolean; rate: string; excluded: string[] }>(
      `SELECT is_active, earn_points_per_dollar::text AS rate, excluded_regulated_classes AS excluded
       FROM loyalty_settings WHERE org_id = current_setting('app.org_id')::uuid`,
    );
    const settings = rows[0];
    if (!settings?.is_active) return null;
    const basis = lines
      .filter((line) => !settings.excluded.includes(line.regulatedClass ?? ''))
      .reduce((sum, line) => sum + line.amount, 0n);
    return pointsForBasis(basis, settings.rate);
  }

  /** A guest cart becomes the customer's once they sign in while holding it. */
  private async claimTx(tx: PoolClient, cart: LockedCart, session: CustomerSession | null): Promise<void> {
    if (!session || cart.customer_id === session.customerId) return;
    if (cart.customer_id !== null) throw ApiException.notFound('cart');
    await tx.query(`UPDATE carts SET customer_id = $1 WHERE id = $2`, [session.customerId, cart.id]);
    cart.customer_id = session.customerId;
  }

  /**
   * Set one line, refusing anything the shopper could not actually buy the way
   * this cart is being fulfilled.
   *
   * Refused with a sentence rather than accepted and flagged: someone pressing
   * "add" on an item that just sold out should be told at that moment, not
   * discover it at checkout.
   */
  private async writeLineTx(tx: PoolClient, cart: LockedCart, variantId: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ApiException('validation_failed', 'quantity must be a whole number', { retryable: false });
    }

    if (quantity === 0) {
      await tx.query(`DELETE FROM cart_lines WHERE cart_id = $1 AND variant_id = $2`, [cart.id, variantId]);
      await this.touchTx(tx, cart);
      return;
    }

    if (quantity > MAX_QUANTITY) {
      throw new ApiException('conflict', `You can order up to ${MAX_QUANTITY} of one item online.`, {
        retryable: false,
      });
    }

    const { rows } = await tx.query<{
      availability: string | null;
      sellable: string | null;
      max_per_order: string | null;
      has_price: boolean;
      active: boolean;
    }>(
      `SELECT l.availability::text AS availability, a.sellable::text AS sellable, l.max_per_order::text AS max_per_order,
              EXISTS (SELECT 1 FROM variant_prices vp
                      WHERE vp.variant_id = v.id AND (vp.store_id = $2 OR vp.store_id IS NULL)
                        AND vp.kind = 'regular' AND vp.effective_from <= now()
                        AND (vp.effective_to IS NULL OR vp.effective_to > now()))
                OR l.online_price_minor IS NOT NULL AS has_price,
              (v.status = 'active' AND p.status = 'active') AS active
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN storefront_listings l ON l.variant_id = v.id
       LEFT JOIN storefront_availability a ON a.variant_id = v.id AND a.store_id = $2
       WHERE v.id = $1`,
      [variantId, cart.store_id],
    );
    const row = rows[0];
    const how = cart.fulfilment === 'delivery' ? 'for delivery' : 'for pickup';
    if (!row?.active || !row.has_price || !row.availability || row.availability === 'hidden') {
      throw new ApiException('conflict', 'This item is no longer available online.', { retryable: false });
    }
    if (!LISTED_FOR[cart.fulfilment].includes(row.availability)) {
      throw new ApiException('conflict', `This item isn't available ${how}.`, { retryable: false });
    }

    const decision = (await this.catalog.decisions(tx, cart.store_id, [variantId], cart.fulfilment)).get(variantId);
    if (!decision?.allowed) {
      throw new ApiException('conflict', `This item can't be ordered online ${how}.`, { retryable: false });
    }

    const sellable = row.sellable === null ? 0 : wholeUnits(row.sellable);
    if (sellable < 1) {
      throw new ApiException('conflict', 'This item is out of stock.', { retryable: false });
    }
    if (quantity > sellable) {
      throw new ApiException('conflict', `Only ${sellable} left.`, { retryable: false });
    }
    if (row.max_per_order !== null && quantity > wholeUnits(row.max_per_order)) {
      throw new ApiException('conflict', `Limit ${wholeUnits(row.max_per_order)} per order.`, { retryable: false });
    }

    const { rows: counted } = await tx.query<{ lines: number; present: boolean }>(
      `SELECT count(*)::int AS lines, bool_or(variant_id = $2) AS present FROM cart_lines WHERE cart_id = $1`,
      [cart.id, variantId],
    );
    if (!counted[0]?.present && (counted[0]?.lines ?? 0) >= MAX_LINES) {
      throw new ApiException('conflict', `A cart can hold up to ${MAX_LINES} different items.`, {
        retryable: false,
      });
    }

    await tx.query(
      `INSERT INTO cart_lines (org_id, cart_id, variant_id, quantity)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3)
       ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cart.id, variantId, quantity],
    );
    await this.touchTx(tx, cart);
  }

  /** A cart someone is still using does not expire under them. */
  private async touchTx(tx: PoolClient, cart: LockedCart): Promise<void> {
    await tx.query(`UPDATE carts SET expires_at = now() + make_interval(days => $2) WHERE id = $1`, [
      cart.id,
      CART_DAYS,
    ]);
  }
}
