import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ComplianceRuleView, CreateComplianceRule, LiftComplianceRule } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const COLUMNS = `id, (org_id IS NULL) AS platform, name, priority, effect, effect_age, channel,
                 scope_country, scope_region, subject_category_path_prefix, subject_regulated_class,
                 deny_message, authority_note, effective_from, effective_to,
                 (effective_from <= now() AND (effective_to IS NULL OR effective_to > now())) AS live`;

/**
 * The lift in force for a rule, or null. Row level security already limits the
 * table to this organization, so this cannot see another shop's decision.
 *
 * A rule that is lifted still appears in this list, and still reads as `live`:
 * it is in force on the platform. `lift` is what says it is not in force here,
 * and carries the authority it was lifted on.
 */
const LIFT = `(
  SELECT to_jsonb(lift) FROM (
    SELECT l.id,
           to_char(l.counsel_reviewed_on, 'YYYY-MM-DD') AS counsel_reviewed_on,
           l.permit_reference, l.authority_note, l.effective_from, l.effective_to
    FROM compliance_rule_lifts l
    WHERE l.rule_id = r.id
      AND l.effective_from <= now()
      AND (l.effective_to IS NULL OR l.effective_to > now())
    ORDER BY l.effective_from DESC
    LIMIT 1
  ) lift
) AS lift`;

/**
 * The rules the shop manages for itself.
 *
 * Rules are added and ended, never edited or deleted. "What was allowed on the
 * night of the 14th" has to stay answerable, so a change is a new rule and the
 * old one's end date -- and every decision already recorded still names the
 * rules that were in force when it was made.
 *
 * The platform's own rules are shown alongside and cannot be changed here, and
 * adding a rule of the shop's own does not outweigh one: a deny ends an
 * evaluation wherever it is found, which is what makes the engine fail closed.
 * Where the platform ships a hold pending legal review, the shop lifts it --
 * see `lift` below -- and that is the only way a platform rule stops applying.
 */
@Injectable()
export class ComplianceRulesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<ComplianceRuleView[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<ComplianceRuleView>(
        `SELECT ${COLUMNS}, ${LIFT} FROM compliance_rules r
         ORDER BY (r.effective_to IS NULL OR r.effective_to > now()) DESC,
                  (r.org_id IS NULL), r.channel NULLS FIRST, r.priority, r.name`,
      );
      return rows;
    });
  }

  async create(orgId: string, actorUserId: string, input: CreateComplianceRule): Promise<ComplianceRuleView> {
    return this.db.withOrg(orgId, async (tx) => {
      const categoryPath = input.category_path?.trim() || null;
      if (categoryPath) {
        const { rows } = await tx.query(`SELECT 1 FROM categories WHERE path = $1 AND status = 'active'`, [
          categoryPath,
        ]);
        if (rows.length === 0) {
          throw new ApiException('validation_failed', `there is no category at ${categoryPath}`, {
            retryable: false,
          });
        }
      }

      const { rows } = await tx.query<ComplianceRuleView>(
        `INSERT INTO compliance_rules
           (org_id, name, scope_country, subject_category_path_prefix, channel, effect, effect_age,
            deny_message, authority_note, created_by)
         SELECT o.id, $1, o.country, $2, $3::compliance_channel, $4::compliance_effect, $5, $6, $7, $8
         FROM organizations o WHERE o.id = current_setting('app.org_id')::uuid
         RETURNING ${COLUMNS}, NULL::jsonb AS lift`,
        [
          input.name,
          categoryPath,
          input.channel,
          input.effect,
          input.effect === 'require_age' ? input.effect_age ?? null : null,
          input.effect === 'deny' ? input.deny_message || null : null,
          input.authority_note,
          actorUserId,
        ],
      );
      const rule = rows[0]!;

      await this.audit.record(tx, {
        action: 'compliance.rule.created',
        entityType: 'compliance_rule',
        entityId: rule.id,
        actorUserId,
        newValue: rule,
        reason: input.authority_note,
      });
      return rule;
    });
  }

  /** End one of the shop's own rules from now. A platform rule is not the shop's to end. */
  async end(orgId: string, actorUserId: string, id: string, reason: string): Promise<ComplianceRuleView> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<ComplianceRuleView>(
        `UPDATE compliance_rules SET effective_to = now()
         WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid
           AND effective_from < now()
           AND (effective_to IS NULL OR effective_to > now())
         RETURNING ${COLUMNS}, NULL::jsonb AS lift`,
        [id],
      );
      const rule = rows[0];
      if (!rule) throw ApiException.notFound('rule in force belonging to this shop');

      await this.audit.record(tx, {
        action: 'compliance.rule.ended',
        entityType: 'compliance_rule',
        entityId: id,
        actorUserId,
        newValue: { effective_to: rule.effective_to },
        reason,
      });
      return rule;
    });
  }

  /**
   * Take a platform rule out of force for this shop.
   *
   * The platform ships some rules denying until somebody has done the legal
   * work -- delivery of ENDS is the one a vape shop runs into on day one. The
   * shop cannot end that rule and cannot outweigh it, so this is how it stops
   * applying: not by changing the rule, and not by changing how rules are
   * judged, but by no longer being in force for this organization. The
   * evaluator never learns a thing about it.
   *
   * What it costs is the attestation. A date counsel reviewed it, the permit
   * the shop trades under, and a note -- all required by the table itself, so
   * a lift cannot exist without the answer to "on whose authority".
   */
  async lift(
    orgId: string,
    actorUserId: string,
    ruleId: string,
    input: LiftComplianceRule,
  ): Promise<ComplianceRuleView> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: found } = await tx.query<{ platform: boolean; name: string }>(
        `SELECT (org_id IS NULL) AS platform, name FROM compliance_rules WHERE id = $1`,
        [ruleId],
      );
      const rule = found[0];
      if (!rule) throw ApiException.notFound('rule');
      if (!rule.platform) {
        throw new ApiException('validation_failed', 'this is your own rule; end it rather than lifting it', {
          retryable: false,
        });
      }

      const { rows: existing } = await tx.query<{ id: string }>(
        `SELECT id FROM compliance_rule_lifts
         WHERE rule_id = $1 AND (effective_to IS NULL OR effective_to > now())`,
        [ruleId],
      );
      if (existing[0]) {
        throw new ApiException('conflict', 'this rule is already lifted for this shop', { retryable: false });
      }

      const { rows: lifted } = await tx.query<{ id: string }>(
        `INSERT INTO compliance_rule_lifts
           (org_id, rule_id, counsel_reviewed_on, permit_reference, authority_note, lifted_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2::date, $3, $4, $5)
         RETURNING id`,
        [ruleId, input.counsel_reviewed_on, input.permit_reference, input.authority_note, actorUserId],
      );

      await this.audit.record(tx, {
        action: 'compliance.rule.lifted',
        entityType: 'compliance_rule',
        entityId: ruleId,
        actorUserId,
        newValue: {
          lift_id: lifted[0]!.id,
          rule_name: rule.name,
          counsel_reviewed_on: input.counsel_reviewed_on,
          permit_reference: input.permit_reference,
        },
        reason: input.authority_note,
      });

      return this.oneTx(tx, ruleId);
    });
  }

  /** Put a lifted rule back in force here. The shop stops trading on it the moment this lands. */
  async withdrawLift(
    orgId: string,
    actorUserId: string,
    ruleId: string,
    reason: string,
  ): Promise<ComplianceRuleView> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE compliance_rule_lifts
            SET effective_to = now(), withdrawn_by = $2, withdrawn_note = $3
          WHERE rule_id = $1 AND (effective_to IS NULL OR effective_to > now())
          RETURNING id`,
        [ruleId, actorUserId, reason],
      );
      if (!rows[0]) throw ApiException.notFound('lift in force for this rule');

      await this.audit.record(tx, {
        action: 'compliance.rule.lift_withdrawn',
        entityType: 'compliance_rule',
        entityId: ruleId,
        actorUserId,
        newValue: { lift_id: rows[0].id },
        reason,
      });

      return this.oneTx(tx, ruleId);
    });
  }

  private async oneTx(tx: PoolClient, ruleId: string): Promise<ComplianceRuleView> {
    const { rows } = await tx.query<ComplianceRuleView>(
      `SELECT ${COLUMNS}, ${LIFT} FROM compliance_rules r WHERE r.id = $1`,
      [ruleId],
    );
    const rule = rows[0];
    if (!rule) throw ApiException.notFound('rule');
    return rule;
  }
}
