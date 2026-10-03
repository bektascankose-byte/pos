import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  pointsValueMinor,
  type CustomerDisplayBirthday,
  type CustomerDisplayContact,
  type CustomerDisplayIdentifyResult,
  type CustomerDisplayMember,
  type CustomerDisplayOffers,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { LoyaltyLedger } from '../loyalty/loyalty-ledger.service.js';

interface MemberRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  birth_month: number | null;
  birth_day: number | null;
  status: string;
  anonymized_at: string | null;
}

const MEMBER_COLUMNS = `id, first_name, last_name, phone, email, birth_month, birth_day,
       status::text AS status, anonymized_at`;

/** Recorded on everything this service writes, so the log says which screen it came from. */
const VIA = 'customer_display';

/**
 * What the customer's own screen at the counter may do.
 *
 * See `@snappos/contracts` `customer-display.ts` for why these exist beside
 * the customer endpoints rather than reusing them: the customer is the one
 * acting, the cashier on shift is only who the register happens to be signed
 * in as, and each write is cut down to what a stranger at a keypad can be
 * trusted with.
 */
@Injectable()
export class CustomerDisplayService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ledger: LoyaltyLedger,
  ) {}

  /** Find a member by the exact phone or email they typed. */
  async identify(orgId: string, input: CustomerDisplayContact): Promise<CustomerDisplayIdentifyResult> {
    return this.db.withOrg(orgId, async (tx) => {
      const row = await this.findTx(tx, input);
      // An archived or anonymized customer is somebody the shop removed. To
      // the screen that is the same as not being a member; `join` is where
      // the difference is handled.
      if (!row || row.status !== 'active' || row.anonymized_at) return { found: false, member: null };
      return { found: true, member: await this.memberTx(tx, row, input, false) };
    });
  }

  /**
   * A customer adding themselves, with the one contact they typed.
   *
   * Tapping Join twice, or two registers racing, must not make two members
   * or fail the second time, so an existing active member with that contact
   * is simply returned. A contact that belongs to a customer the shop has
   * archived is refused instead: bringing them back from a keypad would undo
   * a decision somebody in the back office made, and the cashier standing
   * there can sort it out.
   */
  async join(
    orgId: string,
    actorUserId: string,
    storeId: string | null,
    input: CustomerDisplayContact,
  ): Promise<CustomerDisplayMember> {
    return this.db.withOrg(orgId, async (tx) => {
      const existing = await this.findTx(tx, input);
      if (existing) {
        if (existing.status !== 'active' || existing.anonymized_at) throw staffNeeded();
        return this.memberTx(tx, existing, input, false);
      }

      const { rows } = await tx.query<MemberRow>(
        `INSERT INTO customers (org_id, phone, email, home_store_id)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING ${MEMBER_COLUMNS}`,
        [input.phone ?? null, input.email ?? null, storeId],
      );
      const created = rows[0];
      if (!created) {
        // Lost a race with another insert of the same contact. Whoever won
        // made the member this customer wanted.
        const winner = await this.findTx(tx, input);
        if (!winner || winner.status !== 'active' || winner.anonymized_at) throw staffNeeded();
        return this.memberTx(tx, winner, input, false);
      }

      await this.audit.record(tx, {
        action: 'customer.self_join',
        entityType: 'customer',
        entityId: created.id,
        actorUserId,
        newValue: { phone: input.phone ?? null, email: input.email ?? null, via: VIA },
      });
      return this.memberTx(tx, created, input, true);
    });
  }

  /**
   * A birthday, given once.
   *
   * The update only matches a member whose birthday is missing. One who has
   * a birthday is left exactly as they are and the caller is told nothing
   * was saved, so the screen cannot be used to change a birthday by typing
   * somebody else's number first.
   */
  async setBirthday(
    orgId: string,
    actorUserId: string,
    customerId: string,
    input: CustomerDisplayBirthday,
  ): Promise<{ saved: boolean }> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE customers SET birth_month = $2, birth_day = $3
         WHERE id = $1 AND status = 'active' AND anonymized_at IS NULL
           AND (birth_month IS NULL OR birth_day IS NULL)
         RETURNING id`,
        [customerId, input.birth_month, input.birth_day],
      );
      if (!rows[0]) {
        await this.activeMemberTx(tx, customerId);
        return { saved: false };
      }
      await this.audit.record(tx, {
        action: 'customer.birthday_set',
        entityType: 'customer',
        entityId: customerId,
        actorUserId,
        newValue: { birth_month: input.birth_month, birth_day: input.birth_day, via: VIA },
      });
      return { saved: true };
    });
  }

  /**
   * The customer's own yes or no to offers, appended to the consent log.
   *
   * Source `register`: it happened at the counter. The evidence says it was
   * the customer's screen rather than a cashier ticking a box, who was on
   * shift, and the words the customer was shown. A "no" is recorded too. It
   * is an answer, and it is what stops the screen asking the same person
   * again on every visit.
   *
   * Only for a channel the member can be reached on. Consent to text someone
   * with no phone number on file is a row that could only ever mislead.
   */
  async setOffers(
    orgId: string,
    actorUserId: string,
    customerId: string,
    input: CustomerDisplayOffers,
  ): Promise<{ saved: boolean }> {
    return this.db.withOrg(orgId, async (tx) => {
      const member = await this.activeMemberTx(tx, customerId);
      const reachable = input.channel === 'sms' ? member.phone : member.email;
      if (!reachable) {
        throw new ApiException(
          'validation_failed',
          `this customer has no ${input.channel === 'sms' ? 'phone number' : 'email'} on file`,
          { retryable: false },
        );
      }

      await tx.query(
        `INSERT INTO customer_consents (org_id, customer_id, channel, granted, source, evidence)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, 'register', $4::jsonb)`,
        [
          customerId,
          input.channel,
          input.granted,
          JSON.stringify({ via: VIA, on_shift: actorUserId, wording: input.wording }),
        ],
      );
      await this.audit.record(tx, {
        action: input.granted ? 'customer.consent_grant' : 'customer.consent_revoke',
        entityType: 'customer',
        entityId: customerId,
        actorUserId,
        newValue: { channel: input.channel, source: 'register', via: VIA },
      });
      return { saved: true };
    });
  }

  // ---------------------------------------------------------------------------

  /** Exact match on whichever contact was sent, in any status. */
  private async findTx(tx: PoolClient, input: CustomerDisplayContact): Promise<MemberRow | undefined> {
    const { rows } = await tx.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM customers
       WHERE ($1::text IS NOT NULL AND phone = $1)
          OR ($2::text IS NOT NULL AND lower(email) = lower($2))
       LIMIT 1`,
      [input.phone ?? null, input.email ?? null],
    );
    return rows[0];
  }

  private async activeMemberTx(tx: PoolClient, customerId: string): Promise<MemberRow> {
    const { rows } = await tx.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM customers WHERE id = $1`,
      [customerId],
    );
    const row = rows[0];
    if (!row || row.status !== 'active' || row.anonymized_at) throw ApiException.notFound('customer');
    return row;
  }

  private async memberTx(
    tx: PoolClient,
    row: MemberRow,
    typed: CustomerDisplayContact,
    joined: boolean,
  ): Promise<CustomerDisplayMember> {
    const settings = await this.ledger.settingsTx(tx);
    const balance = await this.ledger.balanceTx(tx, row.id);

    // The channel of the contact they typed: a customer who gave a phone is
    // asked about texts, one who gave an email about email.
    const channel = typed.phone !== undefined ? 'sms' : 'email';
    const { rows: answered } = await tx.query(
      `SELECT 1 FROM customer_consents WHERE customer_id = $1 AND channel = $2 LIMIT 1`,
      [row.id, channel],
    );

    return {
      customer: {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        phone: row.phone,
        email: row.email,
      },
      joined,
      needs_birthday: row.birth_month === null || row.birth_day === null,
      ask_offers: answered.length === 0 ? channel : null,
      loyalty: {
        program_name: settings.name,
        program_active: settings.is_active,
        points: balance.points,
        value_minor: pointsValueMinor(balance.points, settings.redemption_rate).toString(),
      },
    };
  }
}

/** For the cases a keypad should not settle: the customer is sent to a person. */
function staffNeeded(): ApiException {
  return new ApiException('conflict', 'that contact belongs to a customer who was removed', {
    userMessage: 'Please ask the cashier to add you.',
    retryable: false,
  });
}
