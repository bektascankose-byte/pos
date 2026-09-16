import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  evaluateCompliance,
  type ComplianceChannel,
  type ComplianceContext,
  type ComplianceDecision,
  type ComplianceRule,
  type ComplianceSubject,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';

export interface JurisdictionContext {
  country?: string | null;
  region?: string | null;
  county?: string | null;
  city?: string | null;
  storeId?: string | null;
}

export interface LineDecision extends ComplianceDecision {
  variantId: string;
}

/**
 * The database half of the compliance engine.
 *
 * The decision itself is made by the pure evaluator in `@snappos/contracts`,
 * which this service never second-guesses. Everything here is fetching what it
 * needs and writing down what it said.
 *
 * `compliance_rules` has been in the schema since migration 0002 and nothing
 * had ever read it. It is a better table than the one this was first written
 * against -- it matches categories by path prefix, so a rule on `vapes.`
 * governs the whole subtree, and it carries `overridable` and `deny_message`
 * so a cashier can be told what to do rather than only that something failed.
 */
@Injectable()
export class ComplianceService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Judge a whole cart at once.
   *
   * One rule fetch for every line rather than one per line: a fifteen-item
   * cart checked at add, at checkout and again before payment is forty-five
   * evaluations, and the rules are the same rules every time.
   */
  async checkCart(
    orgId: string,
    channel: ComplianceChannel,
    jurisdiction: JurisdictionContext,
    variantIds: readonly string[],
    asOf: Date = new Date(),
  ): Promise<LineDecision[]> {
    if (variantIds.length === 0) return [];
    return this.db.withOrg(orgId, (tx) =>
      this.checkCartTx(tx, channel, jurisdiction, variantIds, asOf),
    );
  }

  /**
   * The body of `checkCart`, inside a transaction the caller owns.
   *
   * Order placement needs this: the check and the write must see one snapshot,
   * or an order is accepted against rules that changed a moment earlier.
   */
  async checkCartTx(
    tx: PoolClient,
    channel: ComplianceChannel,
    jurisdiction: JurisdictionContext,
    variantIds: readonly string[],
    asOf: Date = new Date(),
  ): Promise<LineDecision[]> {
    const [rules, subjects] = await Promise.all([
      this.loadRules(tx, channel, asOf),
      this.loadSubjects(tx, variantIds),
    ]);

    const context: ComplianceContext = {
      channel,
      country: jurisdiction.country ?? null,
      region: jurisdiction.region ?? null,
      county: jurisdiction.county ?? null,
      city: jurisdiction.city ?? null,
      storeId: jurisdiction.storeId ?? null,
      asOf: asOf.toISOString(),
    };

    return variantIds.map((variantId) => {
      // A variant the catalog does not know is not a reason to fall through to
      // "allowed". It is judged as a bare subject, which fails closed unless a
      // rule genuinely covers everything.
      const subject: ComplianceSubject = subjects.get(variantId) ?? { variantId };
      return { variantId, ...evaluateCompliance(rules, subject, context) };
    });
  }

  /**
   * Everything in force for a channel at a moment.
   *
   * Filtered in SQL only by things that cannot change the answer -- channel and
   * the date window. Scope and subject matching stay in the evaluator, because
   * they are the part that has to behave identically in Kotlin, and a rule
   * silently excluded by a WHERE clause is a rule the fixtures cannot catch
   * being wrong.
   *
   * `channel IS NULL` is included: a null channel means every channel.
   */
  private async loadRules(
    tx: PoolClient,
    channel: ComplianceChannel,
    asOf: Date,
  ): Promise<ComplianceRule[]> {
    const { rows } = await tx.query<{
      id: string;
      org_id: string | null;
      name: string;
      priority: number;
      scope_country: string | null;
      scope_region: string | null;
      scope_county: string | null;
      scope_city: string | null;
      scope_store_id: string | null;
      subject_category_path_prefix: string | null;
      subject_regulated_class: string | null;
      subject_product_id: string | null;
      subject_variant_id: string | null;
      subject_match: Record<string, string> | null;
      channel: ComplianceChannel | null;
      effect: ComplianceRule['effect'];
      effect_age: number | null;
      overridable: boolean;
      deny_message: string | null;
      effective_from: string;
      effective_to: string | null;
      authority_note: string | null;
    }>(
      `SELECT id, org_id, name, priority,
              scope_country, scope_region, scope_county, scope_city, scope_store_id::text,
              subject_category_path_prefix, subject_regulated_class,
              subject_product_id::text, subject_variant_id::text, subject_match,
              channel, effect, effect_age, overridable, deny_message,
              effective_from, effective_to, authority_note
       FROM compliance_rules
       WHERE (channel = $1 OR channel IS NULL)
         AND effective_from <= $2
         AND (effective_to IS NULL OR effective_to > $2)`,
      [channel, asOf],
    );

    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      priority: row.priority,
      scopeCountry: row.scope_country,
      scopeRegion: row.scope_region,
      scopeCounty: row.scope_county,
      scopeCity: row.scope_city,
      scopeStoreId: row.scope_store_id,
      subjectCategoryPathPrefix: row.subject_category_path_prefix,
      subjectRegulatedClass: row.subject_regulated_class,
      subjectProductId: row.subject_product_id,
      subjectVariantId: row.subject_variant_id,
      subjectMatch: row.subject_match,
      channel: row.channel,
      effect: row.effect,
      effectAge: row.effect_age,
      overridable: row.overridable,
      denyMessage: row.deny_message,
      effectiveFrom: new Date(row.effective_from).toISOString(),
      effectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
      authorityNote: row.authority_note,
    }));
  }

  /** What each variant IS, in the terms rules are written in. */
  private async loadSubjects(
    tx: PoolClient,
    variantIds: readonly string[],
  ): Promise<Map<string, ComplianceSubject>> {
    const { rows } = await tx.query<{
      variant_id: string;
      product_id: string;
      category_path: string | null;
      regulated_class: string | null;
      attributes: Record<string, string> | null;
    }>(
      `SELECT v.id AS variant_id, v.product_id, c.path AS category_path,
              pc.regulated_class, v.attributes
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_compliance pc ON pc.product_id = p.id
       WHERE v.id = ANY($1::uuid[])`,
      [variantIds],
    );

    return new Map(
      rows.map((row) => [
        row.variant_id,
        {
          variantId: row.variant_id,
          productId: row.product_id,
          categoryPath: row.category_path,
          regulatedClass: row.regulated_class,
          attributes: row.attributes,
        },
      ]),
    );
  }

  /**
   * Write down what was decided and on what basis.
   *
   * Not a cache. Rules change, and a stored decision must never be replayed as
   * though it were still current -- what this is for is being able to show,
   * afterwards, exactly which rules were in force when an order was accepted.
   * That is the difference between believing you complied and demonstrating it.
   */
  async record(
    tx: PoolClient,
    input: {
      orderId?: string | undefined;
      channel: ComplianceChannel;
      jurisdiction: JurisdictionContext;
      asOf: Date;
      decisions: readonly LineDecision[];
    },
  ): Promise<void> {
    for (const decision of input.decisions) {
      await tx.query(
        `INSERT INTO compliance_decisions
           (org_id, order_id, variant_id, channel, allowed, reason, minimum_age,
            requires_id_scan, requires_manager, requires_provider_verification,
            overridable, matched_rule_ids, jurisdiction, evaluated_as_of)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11::uuid[], $12::jsonb, $13)`,
        [
          input.orderId ?? null,
          decision.variantId,
          input.channel,
          decision.allowed,
          decision.reason,
          decision.minimumAge,
          decision.requiresIdScan,
          decision.requiresManager,
          decision.requiresProviderVerification,
          decision.overridable,
          decision.matchedRuleIds,
          JSON.stringify(input.jurisdiction),
          input.asOf,
        ],
      );
    }
  }
}
