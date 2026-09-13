import { Injectable } from '@nestjs/common';
import type { UpdateLoyaltySettings } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';

const SETTINGS_COLUMNS = `name, is_active, earn_points_per_dollar::text, redemption_points_per_dollar::text,
       minimum_redemption_points, points_expire_after_days, updated_at`;

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Every org has settings the moment anyone asks -- a no-op upsert creates the default row on first read, so there's nothing to provision ahead of time. */
  async get(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO loyalty_settings (org_id)
         VALUES (current_setting('app.org_id')::uuid)
         ON CONFLICT (org_id) DO UPDATE SET org_id = loyalty_settings.org_id
         RETURNING ${SETTINGS_COLUMNS}`,
      );
      return rows[0];
    });
  }

  async update(orgId: string, actorUserId: string, input: UpdateLoyaltySettings) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO loyalty_settings
           (org_id, name, is_active, earn_points_per_dollar, redemption_points_per_dollar,
            minimum_redemption_points, points_expire_after_days, updated_by)
         VALUES (
           current_setting('app.org_id')::uuid,
           COALESCE($1, 'Loyalty Rewards'), COALESCE($2, false), COALESCE($3, 1::numeric), COALESCE($4, 100::numeric),
           $5, $6, $7
         )
         ON CONFLICT (org_id) DO UPDATE SET
           name                         = COALESCE($1, loyalty_settings.name),
           is_active                    = COALESCE($2, loyalty_settings.is_active),
           earn_points_per_dollar       = COALESCE($3, loyalty_settings.earn_points_per_dollar),
           redemption_points_per_dollar = COALESCE($4, loyalty_settings.redemption_points_per_dollar),
           minimum_redemption_points    = COALESCE($5, loyalty_settings.minimum_redemption_points),
           points_expire_after_days     = COALESCE($6, loyalty_settings.points_expire_after_days),
           updated_by                   = $7
         RETURNING ${SETTINGS_COLUMNS}`,
        [
          input.name ?? null,
          input.is_active ?? null,
          input.earn_points_per_dollar ?? null,
          input.redemption_points_per_dollar ?? null,
          input.minimum_redemption_points ?? null,
          input.points_expire_after_days ?? null,
          actorUserId,
        ],
      );
      const settings = rows[0];

      await this.audit.record(tx, {
        action: 'loyalty.settings_update',
        entityType: 'loyalty_settings',
        entityId: orgId,
        actorUserId,
        newValue: input,
      });

      return settings;
    });
  }
}
