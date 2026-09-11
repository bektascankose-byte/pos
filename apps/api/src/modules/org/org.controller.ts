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

  /**
   * Registers, each with the last receipt sequence it used.
   *
   * `last_sequence` matters more than it looks. Receipt numbers are composed on
   * the device as `{store}-{register}-{sequence}` from a counter held locally,
   * which is what lets a receipt print with no network. But that counter lives
   * only on the device, so a terminal that is replaced, wiped or reinstalled
   * starts again at 1 and collides with receipt numbers the server already has
   * — `sales_receipt_key` rejects the upload, and a legitimate sale can never
   * be handed over.
   *
   * So the server, which does have the whole history, reports where the
   * register got to. A re-provisioned device resumes from there.
   */
  @Get('registers')
  registers(@CurrentUser() user: AuthenticatedUser) {
    return this.db.withOrg(user.orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.store_id, r.code, r.name, r.status,
                COALESCE(
                  (SELECT max(s.register_sequence) FROM sales s WHERE s.register_id = r.id),
                  0
                )::text AS last_sequence
         FROM registers r WHERE r.status = 'active' ORDER BY r.code`,
      );
      return { data: rows };
    });
  }
}
