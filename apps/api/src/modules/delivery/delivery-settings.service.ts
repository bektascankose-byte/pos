import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DeliverySettings, DeliveryTerms, UpdateDeliverySettings } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { CourierService } from '../../platform/couriers/courier.service.js';
import { PaymentsService } from '../../platform/payments/payments.service.js';
import { AgeVerificationService } from '../../platform/age-verification/age-verification.service.js';
import { ComplianceService, type JurisdictionContext } from '../compliance/compliance.service.js';

interface SettingsRow {
  enabled: boolean;
  provider: string;
  postal_codes: string[];
  fee_minor: string;
  free_over_minor: string | null;
  minimum_subtotal_minor: string;
  last_order_minutes_before_close: number;
  pickup_instructions: string | null;
  updated_at: Date | null;
}

/** What checkout and the cart need to know about delivering from one store. */
export interface DeliveryOffer {
  /** Switched on by the shop, and everything it depends on is available on this server. */
  offered: boolean;
  /** Courier, payment or age check is simulated here. */
  simulated: boolean;
  providerName: string;
  terms: DeliveryTerms;
  pickupInstructions: string | null;
}

/**
 * Where a store delivers and on what terms, and whether it can right now.
 *
 * Delivery depends on three outside services -- a courier, a card processor
 * and an age check -- and on the shop's own details a driver needs. The back
 * office is told plainly which of those is missing or simulated, so "delivery
 * is on" never means something different on the website than it does here.
 */
@Injectable()
export class DeliverySettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly couriers: CourierService,
    private readonly payments: PaymentsService,
    private readonly ages: AgeVerificationService,
    private readonly compliance: ComplianceService,
  ) {}

  async get(orgId: string, storeId: string): Promise<DeliverySettings> {
    return this.db.withOrg(orgId, (tx) => this.getTx(tx, storeId));
  }

  async getTx(tx: PoolClient, storeId: string): Promise<DeliverySettings> {
    const row = await this.rowTx(tx, storeId);
    return {
      enabled: row.enabled,
      provider: row.provider,
      postal_codes: row.postal_codes,
      fee_minor: row.fee_minor,
      free_over_minor: row.free_over_minor,
      minimum_subtotal_minor: row.minimum_subtotal_minor,
      last_order_minutes_before_close: row.last_order_minutes_before_close,
      pickup_instructions: row.pickup_instructions,
      courier_mode: this.couriers.mode(),
      problems: await this.problemsTx(tx, storeId, row),
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  async offerTx(tx: PoolClient, storeId: string): Promise<DeliveryOffer> {
    const row = await this.rowTx(tx, storeId);
    const modes = [this.couriers.mode(), this.payments.mode(), this.ages.mode()];
    return {
      offered: row.enabled && !modes.includes('unavailable'),
      simulated: modes.includes('simulated'),
      providerName: 'DoorDash',
      terms: {
        postal_codes: row.postal_codes,
        fee_minor: BigInt(row.fee_minor),
        free_over_minor: row.free_over_minor === null ? null : BigInt(row.free_over_minor),
        minimum_subtotal_minor: BigInt(row.minimum_subtotal_minor),
      },
      pickupInstructions: row.pickup_instructions,
    };
  }

  async update(orgId: string, actorUserId: string, storeId: string, input: UpdateDeliverySettings) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: stores } = await tx.query(`SELECT 1 FROM stores WHERE id = $1`, [storeId]);
      if (!stores[0]) throw ApiException.notFound('store');

      const before = await this.rowTx(tx, storeId);
      const postalCodes = input.postal_codes ? [...new Set(input.postal_codes)].sort() : null;

      await tx.query(
        `INSERT INTO store_delivery_settings
           (store_id, org_id, enabled, postal_codes, fee_minor, free_over_minor, minimum_subtotal_minor,
            last_order_minutes_before_close, pickup_instructions, updated_by)
         VALUES ($1, current_setting('app.org_id')::uuid, COALESCE($2, false), COALESCE($3::text[], '{}'),
                 COALESCE($4::bigint, 0), $5::bigint, COALESCE($6::bigint, 0), COALESCE($7::smallint, 30), $8, $9)
         ON CONFLICT (store_id) DO UPDATE SET
           enabled                         = COALESCE($2, store_delivery_settings.enabled),
           postal_codes                    = COALESCE($3::text[], store_delivery_settings.postal_codes),
           fee_minor                       = COALESCE($4::bigint, store_delivery_settings.fee_minor),
           free_over_minor                 = CASE WHEN $10::boolean THEN $5::bigint ELSE store_delivery_settings.free_over_minor END,
           minimum_subtotal_minor          = COALESCE($6::bigint, store_delivery_settings.minimum_subtotal_minor),
           last_order_minutes_before_close = COALESCE($7::smallint, store_delivery_settings.last_order_minutes_before_close),
           pickup_instructions             = CASE WHEN $11::boolean THEN $8 ELSE store_delivery_settings.pickup_instructions END,
           updated_by                      = $9`,
        [
          storeId,
          input.enabled ?? null,
          postalCodes,
          input.fee_minor ?? null,
          input.free_over_minor ?? null,
          input.minimum_subtotal_minor ?? null,
          input.last_order_minutes_before_close ?? null,
          input.pickup_instructions ?? null,
          actorUserId,
          input.free_over_minor !== undefined,
          input.pickup_instructions !== undefined,
        ],
      );

      await this.audit.record(tx, {
        action: 'delivery.settings_update',
        entityType: 'store',
        entityId: storeId,
        actorUserId,
        storeId,
        oldValue: before,
        newValue: input,
      });
      return this.getTx(tx, storeId);
    });
  }

  private async rowTx(tx: PoolClient, storeId: string): Promise<SettingsRow> {
    const { rows } = await tx.query<SettingsRow>(
      `SELECT enabled, provider, postal_codes, fee_minor::text, free_over_minor::text,
              minimum_subtotal_minor::text, last_order_minutes_before_close, pickup_instructions, updated_at
       FROM store_delivery_settings WHERE store_id = $1`,
      [storeId],
    );
    return (
      rows[0] ?? {
        enabled: false,
        provider: 'doordash',
        postal_codes: [],
        fee_minor: '0',
        free_over_minor: null,
        minimum_subtotal_minor: '0',
        last_order_minutes_before_close: 30,
        pickup_instructions: null,
        updated_at: null,
      }
    );
  }

  private async problemsTx(tx: PoolClient, storeId: string, row: SettingsRow): Promise<string[]> {
    const problems: string[] = [];
    const { rows: stores } = await tx.query<{
      address_line1: string | null;
      postal_code: string | null;
      phone: string | null;
    }>(`SELECT address_line1, postal_code, phone FROM stores WHERE id = $1`, [storeId]);
    const store = stores[0];

    if (row.postal_codes.length === 0) problems.push('Add the ZIP codes you deliver to.');
    if (!store?.address_line1 || !store.postal_code) {
      problems.push("Add the store's street address and ZIP code. Drivers collect from it.");
    }
    if (!store?.phone) problems.push("Add the store's phone number. Drivers call it if they can't find the order.");

    const { rows: rules } = await tx.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM compliance_rules
         WHERE effect = 'allow' AND (channel = 'delivery' OR channel IS NULL)
           AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
       ) AS allowed`,
    );
    if (!rules[0]?.allowed) problems.push('No selling rule allows delivery yet, so nothing can be ordered for delivery.');

    const { rows: listed } = await tx.query<{ variant_id: string }>(
      `SELECT l.variant_id
         FROM storefront_listings l
         JOIN product_variants v ON v.id = l.variant_id AND v.status = 'active'
        WHERE l.availability IN ('delivery_only', 'pickup_and_delivery')
        LIMIT 200`,
    );
    if (listed.length === 0) {
      problems.push('No products are listed for delivery yet (each product\'s Sell Online tab).');
    } else {
      // Asking the engine rather than asking whether a rule exists. A shop can
      // switch delivery on, write an allow, list a vape for it, and still not
      // be able to sell one, because the platform holds ENDS delivery back
      // until counsel has reviewed it -- and a deny ends an evaluation
      // wherever it appears. Telling the shop it is ready when every cart will
      // be refused is the kind of readiness check that costs somebody a
      // morning on the phone.
      const decisions = await this.compliance.checkCartTx(
        tx,
        'delivery',
        await this.jurisdictionTx(tx, storeId),
        listed.map((row) => row.variant_id),
      );
      if (!decisions.some((decision) => decision.allowed)) {
        const blocking = await this.blockingRulesTx(tx, decisions.flatMap((d) => d.matchedRuleIds));
        problems.push(
          blocking.length > 0
            ? `Nothing listed for delivery may actually be sold that way: ${blocking.join(', ')}. ` +
              'Your attorney reviews the rule, then you lift it on the Compliance page.'
            : 'Nothing listed for delivery may actually be sold that way under the rules in force.',
        );
      }
    }

    const courier = this.couriers.mode();
    if (courier === 'simulated') {
      problems.push("DoorDash isn't connected yet, so deliveries are simulated. Add the DoorDash credentials to go live.");
    }
    if (courier === 'unavailable') {
      problems.push("DoorDash isn't connected on this server, so delivery can't be offered.");
    }
    if (this.payments.mode() === 'simulated') {
      problems.push('Online payment is in test mode: no card is asked for and nothing is charged.');
    }
    if (this.ages.mode() === 'simulated') {
      problems.push('The age check on delivery orders is a test. It does not verify anyone until a provider is chosen.');
    }
    return problems;
  }

  private async jurisdictionTx(tx: PoolClient, storeId: string): Promise<JurisdictionContext> {
    const { rows } = await tx.query<{
      country: string | null;
      region: string | null;
      county: string | null;
      city: string | null;
    }>(`SELECT country, region, county, city FROM stores WHERE id = $1`, [storeId]);
    const store = rows[0];
    return {
      country: store?.country ?? null,
      region: store?.region ?? null,
      county: store?.county ?? null,
      city: store?.city ?? null,
      storeId,
    };
  }

  /** The names of the platform denials standing in the way, so the shop knows which one to take to counsel. */
  private async blockingRulesTx(tx: PoolClient, matchedRuleIds: string[]): Promise<string[]> {
    const ids = [...new Set(matchedRuleIds)];
    if (ids.length === 0) return [];
    const { rows } = await tx.query<{ name: string }>(
      `SELECT DISTINCT name FROM compliance_rules
        WHERE id = ANY($1::uuid[]) AND effect = 'deny' AND org_id IS NULL
        ORDER BY name`,
      [ids],
    );
    return rows.map((row) => `"${row.name}"`);
  }
}
