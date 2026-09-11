import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../../platform/database/database.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/**
 * Organization shape: stores and registers.
 *
 * A register calls this immediately after its device is claimed, to learn which
 * store it belongs to and what its own id is. Everything else it does is scoped
 * by those two values, so this is the first authenticated call it ever makes.
 *
 * No explicit permission is required beyond being authenticated. Knowing which
 * stores your own employer operates is not privileged information, and gating
 * it would mean a cashier could not complete the one call that makes a register
 * usable.
 */
@Controller({ path: '', version: '1' })
export class OrgController {
  constructor(private readonly db: DatabaseService) {}

  @Get('stores')
  stores(@CurrentUser() user: AuthenticatedUser) {
    return this.db.withOrg(user.orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, code, name, timezone, city, region, county, country, status
         FROM stores WHERE status = 'active' ORDER BY code`,
      );
      return { data: rows };
    });
  }

  @Get('registers')
  registers(@CurrentUser() user: AuthenticatedUser) {
    return this.db.withOrg(user.orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, store_id, code, name, status
         FROM registers WHERE status = 'active' ORDER BY code`,
      );
      return { data: rows };
    });
  }
}
