import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import {
  normalizeUsPhone,
  phoneHint,
  pointsValueMinor,
  type OrderStatus,
  type ShopCustomerOrder,
  type ShopCustomerProfile,
  type ShopPhoneCodeSent,
  type ShopPhoneVerified,
  type ShopRegister,
  type ShopRewards,
  type ShopSession,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { TransactionalMailer } from '../../platform/messaging/transactional-mailer.js';
import { TransactionalTexter } from '../../platform/messaging/transactional-texter.js';
import type { ShopRequestContext } from '../../platform/shop/shop.guard.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';
import { LoyaltyLedger } from '../loyalty/loyalty-ledger.service.js';
import { customerStatusLabel } from './checkout.service.js';
import { CustomerSessions, hashSecret, type CustomerSession } from './customer-sessions.service.js';
import { PhoneCodes } from './phone-codes.js';
import {
  alreadyRegisteredMessage,
  resetPasswordMessage,
  verifyEmailMessage,
  type EmailContent,
} from './shop-emails.js';
import { TrackingTokens } from './tracking-tokens.js';

/**
 * The same Argon2id parameters staff passwords use (see `AuthService`): about
 * 50ms a guess, unnoticeable signing in once and ruinous to a list of leaked
 * passwords.
 */
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const MAX_FAILURES = 10;
const LOCKOUT_MINUTES = 15;
const VERIFY_HOURS = 24;
const RESET_MINUTES = 60;
/** At most one email of each kind a minute per customer, so a form cannot be used to flood an inbox. */
const EMAIL_EVERY_SECONDS = 60;

const PHONE_CODE_MINUTES = 10;
const PHONE_CODE_ATTEMPTS = 5;
/** At most this many codes an hour -- to one account, and to one phone number from any account. */
const PHONE_CODES_PER_HOUR = 5;
const PHONE_CODE_EVERY_SECONDS = 60;

/** What was on the screen when the box was ticked. Kept as consent evidence. */
const MARKETING_WORDING = (shop: string) =>
  `Email me offers and news from ${shop}. I can unsubscribe at any time.`;

/** Every failed sign-in says exactly this, whatever the reason. */
const SIGN_IN_FAILED = 'That email and password combination is not right.';

interface AccountRow {
  customer_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  password_hash: string | null;
  email_verified_at: Date | null;
  failed_attempts: number | null;
  locked_until: Date | null;
  active: boolean;
}

type PhoneOutcome =
  | { kind: 'ok'; customerId: string; linked: boolean }
  | { kind: 'expired' }
  | { kind: 'wrong'; left: number }
  | { kind: 'taken' }
  | { kind: 'closed' };

/**
 * Customer accounts on the website.
 *
 * Built so that nothing the website says reveals whether an email address has
 * an account. Signing up, asking for a reset and failing to sign in all answer
 * the same way either way, and take the same time -- otherwise the forms become
 * a tool for finding out who shops here, which for this kind of shop is not a
 * harmless thing to be able to find out.
 *
 * Nobody signs in before confirming their address. An in-store customer's email
 * is already on file; without the confirmation, anyone could register that
 * address and read that person's purchase history.
 *
 * The same reasoning makes a phone number something to prove. The register
 * finds a rewards member by phone, so an account that could simply claim a
 * number could collect a stranger's points and read their history. A texted
 * code proves it; once it does, an account whose number is already a rewards
 * member in the shop becomes that member.
 */
@Injectable()
export class CustomerAccountsService {
  private readonly logger = new Logger(CustomerAccountsService.name);
  private readonly dummyHash = hash(randomBytes(16).toString('hex'), ARGON);
  private readonly phoneCodes = new PhoneCodes();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sessions: CustomerSessions,
    private readonly mailer: TransactionalMailer,
    private readonly texter: TransactionalTexter,
    private readonly tokens: TrackingTokens,
    private readonly loyalty: LoyaltyLedger,
  ) {}

  async register(shop: ShopRequestContext, input: ShopRegister): Promise<{ status: 'check_email' }> {
    const email = normaliseEmail(input.email);
    this.refuseEmailAsPassword(email, input.password);
    const phone = input.phone?.trim() ? normalizeUsPhone(input.phone) : null;
    if (input.phone?.trim() && !phone) {
      throw new ApiException('validation_failed', 'Enter a US mobile number, or leave it blank.', { retryable: false });
    }
    const passwordHash = await hash(input.password, ARGON);

    const outgoing = await this.db.withOrg(shop.orgId, async (tx): Promise<EmailContent | null> => {
      const shopName = await this.shopName(tx);
      const existing = await this.findAccount(tx, email);

      if (existing?.password_hash) {
        // Already registered. The person at the keyboard is told what everyone
        // is told; the owner of the address is told someone tried.
        if (await this.throttled(tx, existing.customer_id, 'verify_email')) return null;
        // Kept as a spent token so the throttle above sees it: however often
        // somebody sends the form, the owner gets one of these a minute.
        await tx.query(
          `INSERT INTO customer_tokens (org_id, customer_id, purpose, token_hash, detail, expires_at, used_at)
           VALUES (current_setting('app.org_id')::uuid, $1, 'verify_email', $2,
                   '{"notice": "already_registered"}'::jsonb, now() + interval '1 minute', now())`,
          [existing.customer_id, hashSecret(randomBytes(32).toString('base64url'))],
        );
        return alreadyRegisteredMessage(shopName);
      }

      let customerId: string;
      if (existing) {
        // An in-store customer claiming their record online. Their details on
        // file are left alone until they prove the address is theirs.
        customerId = existing.customer_id;
      } else {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO customers (org_id, first_name, last_name, email, home_store_id)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4)
           RETURNING id`,
          [input.first_name, input.last_name, email, shop.storeId],
        );
        customerId = rows[0]!.id;
      }

      await tx.query(
        `INSERT INTO customer_credentials (customer_id, org_id, password_hash)
         VALUES ($1, current_setting('app.org_id')::uuid, $2)`,
        [customerId, passwordHash],
      );

      const token = await this.issueToken(tx, customerId, 'verify_email', VERIFY_HOURS * 60, {
        first_name: input.first_name,
        last_name: input.last_name,
        marketing_email: input.marketing_email,
        marketing_wording: MARKETING_WORDING(shopName),
        // Not put on the record yet: a code is texted to it once the email is
        // confirmed, and only the code proves it.
        ...(phone ? { rewards_phone: phone } : {}),
        requested_at: new Date().toISOString(),
      });
      return verifyEmailMessage(shopName, token);
    });

    if (outgoing) await this.send('account', email, outgoing);
    return { status: 'check_email' };
  }

  /** Following the confirmation link. Signs the customer straight in, and texts a code to any rewards phone they gave. */
  async verifyEmail(shop: ShopRequestContext, token: string): Promise<ShopSession> {
    const { session, rewardsPhone, customerId } = await this.db.withOrg(shop.orgId, async (tx) => {
      const used = await this.useToken(tx, token, 'verify_email');
      const detail = used.detail as {
        first_name?: string;
        last_name?: string;
        marketing_email?: boolean;
        marketing_wording?: string;
        rewards_phone?: string;
      };

      await tx.query(
        `UPDATE customer_credentials SET email_verified_at = COALESCE(email_verified_at, now())
         WHERE customer_id = $1`,
        [used.customer_id],
      );
      // Names given at sign-up fill in a record that had none, and never
      // overwrite what the shop already had on file.
      await tx.query(
        `UPDATE customers SET first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3)
         WHERE id = $1`,
        [used.customer_id, detail.first_name ?? null, detail.last_name ?? null],
      );
      if (detail.marketing_email === true) {
        await this.recordConsent(tx, shop, used.customer_id, true, 'web_signup', {
          wording: detail.marketing_wording,
          confirmed_by: 'email link',
        });
      }

      return {
        session: await this.startSession(tx, used.customer_id),
        rewardsPhone: detail.rewards_phone ?? null,
        customerId: used.customer_id,
      };
    });

    if (rewardsPhone) {
      try {
        await this.sendPhoneCode(shop, customerId, rewardsPhone);
        session.customer = await this.db.withOrg(shop.orgId, (tx) => this.profileTx(tx, customerId));
      } catch (e) {
        // Signing in still worked; the account page offers to send the code again.
        this.logger.warn({ err: e instanceof Error ? e.message : e }, 'could not text a rewards code after sign-up');
      }
    }
    return session;
  }

  async signIn(shop: ShopRequestContext, emailInput: string, password: string): Promise<ShopSession> {
    const email = normaliseEmail(emailInput);
    const account = await this.db.withOrg(shop.orgId, (tx) => this.findAccount(tx, email));

    // A missing account and a locked one still pay for a hash, so neither
    // answers measurably faster than a wrong password.
    if (!account?.password_hash || (account.locked_until && account.locked_until > new Date())) {
      await verify(await this.dummyHash, password).catch(() => false);
      throw new ApiException('unauthenticated', SIGN_IN_FAILED);
    }

    const correct = await verify(account.password_hash, password).catch(() => false);

    // Decided inside the transaction, acted on after it commits. Throwing from
    // inside would roll back the very things that must stick: the failed
    // attempt that counts toward a lockout, and the fresh confirmation link.
    const outcome = await this.db.withOrg(
      shop.orgId,
      async (tx): Promise<
        { kind: 'failed' } | { kind: 'unverified'; message: EmailContent | null } | { kind: 'ok'; session: ShopSession }
      > => {
        if (!correct) {
          await tx.query(
            `UPDATE customer_credentials
                SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
                    locked_until    = CASE WHEN failed_attempts + 1 >= $2
                                           THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE customer_id = $1`,
            [account.customer_id, MAX_FAILURES, LOCKOUT_MINUTES],
          );
          return { kind: 'failed' };
        }
        if (!account.active) return { kind: 'failed' };

        if (!account.email_verified_at) {
          if (await this.throttled(tx, account.customer_id, 'verify_email')) return { kind: 'unverified', message: null };
          const token = await this.issueToken(tx, account.customer_id, 'verify_email', VERIFY_HOURS * 60, {});
          return { kind: 'unverified', message: verifyEmailMessage(await this.shopName(tx), token) };
        }

        await tx.query(
          `UPDATE customer_credentials SET failed_attempts = 0, locked_until = NULL WHERE customer_id = $1`,
          [account.customer_id],
        );
        return { kind: 'ok', session: await this.startSession(tx, account.customer_id) };
      },
    );

    if (outcome.kind === 'failed') throw new ApiException('unauthenticated', SIGN_IN_FAILED);
    if (outcome.kind === 'unverified') {
      // Only ever said to someone who has just shown they know the password,
      // so it reveals nothing to anyone else.
      if (outcome.message) await this.send('account', account.email, outcome.message);
      throw new ApiException('forbidden', "Confirm your email address first. We've sent you a new link.", {
        retryable: false,
      });
    }
    return outcome.session;
  }

  async signOut(shop: ShopClient, token: string | undefined): Promise<void> {
    await this.sessions.revoke(shop, token);
  }

  async forgotPassword(shop: ShopRequestContext, emailInput: string): Promise<{ status: 'check_email' }> {
    const email = normaliseEmail(emailInput);
    const outgoing = await this.db.withOrg(shop.orgId, async (tx): Promise<EmailContent | null> => {
      const account = await this.findAccount(tx, email);
      if (!account?.password_hash || !account.active) return null;
      if (await this.throttled(tx, account.customer_id, 'reset_password')) return null;

      // One live reset link at a time. Asking again retires the last one.
      await tx.query(
        `UPDATE customer_tokens SET used_at = now()
         WHERE customer_id = $1 AND purpose = 'reset_password' AND used_at IS NULL`,
        [account.customer_id],
      );
      const token = await this.issueToken(tx, account.customer_id, 'reset_password', RESET_MINUTES, {});
      return resetPasswordMessage(await this.shopName(tx), token);
    });

    if (outgoing) await this.send('password-reset', email, outgoing);
    return { status: 'check_email' };
  }

  /**
   * Choosing a new password from a reset link.
   *
   * Following the link proves the inbox is theirs, so it confirms the address
   * too, clears any lockout, and ends every other session -- if the reset was
   * prompted by someone else getting in, they are now out.
   */
  async resetPassword(shop: ShopRequestContext, token: string, password: string): Promise<ShopSession> {
    const passwordHash = await hash(password, ARGON);
    return this.db.withOrg(shop.orgId, async (tx) => {
      const used = await this.useToken(tx, token, 'reset_password');
      const { rows } = await tx.query<{ email: string }>(`SELECT email FROM customers WHERE id = $1`, [
        used.customer_id,
      ]);
      this.refuseEmailAsPassword(rows[0]?.email ?? '', password);

      await tx.query(
        `UPDATE customer_credentials
            SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE customer_id = $1`,
        [used.customer_id, passwordHash],
      );
      await this.sessions.revokeAllTx(tx, used.customer_id);
      return this.startSession(tx, used.customer_id);
    });
  }

  async profile(shop: ShopClient, session: CustomerSession): Promise<ShopCustomerProfile> {
    return this.db.withOrg(shop.orgId, (tx) => this.profileTx(tx, session.customerId));
  }

  /** Names only. A phone number is changed by proving it; see `requestPhoneCode`. */
  async updateProfile(
    shop: ShopClient,
    session: CustomerSession,
    input: { first_name: string; last_name: string },
  ): Promise<ShopCustomerProfile> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      await tx.query(`UPDATE customers SET first_name = $2, last_name = $3 WHERE id = $1`, [
        session.customerId,
        input.first_name,
        input.last_name,
      ]);
      return this.profileTx(tx, session.customerId);
    });
  }

  async changePassword(
    shop: ShopClient,
    session: CustomerSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const account = await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ password_hash: string; email: string }>(
        `SELECT cc.password_hash, c.email FROM customer_credentials cc
         JOIN customers c ON c.id = cc.customer_id WHERE cc.customer_id = $1`,
        [session.customerId],
      );
      return rows[0];
    });
    if (!account || !(await verify(account.password_hash, currentPassword).catch(() => false))) {
      throw new ApiException('validation_failed', 'Your current password is not right.', { retryable: false });
    }
    this.refuseEmailAsPassword(account.email, newPassword);
    const passwordHash = await hash(newPassword, ARGON);

    await this.db.withOrg(shop.orgId, async (tx) => {
      await tx.query(
        `UPDATE customer_credentials SET password_hash = $2, password_changed_at = now() WHERE customer_id = $1`,
        [session.customerId, passwordHash],
      );
      // Everywhere else is signed out; the device the change was made on stays in.
      await this.sessions.revokeAllTx(tx, session.customerId, session.sessionId);
    });
    return { ok: true };
  }

  async setConsents(
    shop: ShopRequestContext,
    session: CustomerSession,
    marketingEmail: boolean,
  ): Promise<ShopCustomerProfile> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const current = await this.profileTx(tx, session.customerId);
      if (current.marketing_email !== marketingEmail) {
        await this.recordConsent(tx, shop, session.customerId, marketingEmail, 'web_account', {
          wording: MARKETING_WORDING(await this.shopName(tx)),
        });
      }
      return this.profileTx(tx, session.customerId);
    });
  }

  async orders(shop: ShopClient, session: CustomerSession): Promise<ShopCustomerOrder[]> {
    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        order_number: string;
        status: OrderStatus;
        placed_at: Date;
        total_minor: string;
        item_count: number;
      }>(
        `SELECT o.id, o.order_number, o.status, o.placed_at, o.total_minor::text,
                (SELECT COALESCE(sum(floor(l.quantity)), 0)::int FROM order_lines l
                  WHERE l.order_id = o.id AND l.removed_at IS NULL) AS item_count
         FROM orders o
         WHERE o.customer_id = $1 AND o.store_id = $2
         ORDER BY o.placed_at DESC
         LIMIT 100`,
        [session.customerId, shop.storeId],
      );
      return rows.map((row) => ({
        order_number: row.order_number,
        tracking_token: this.tokens.sign(shop.orgId, row.id),
        status: row.status,
        status_label: customerStatusLabel(row.status),
        placed_at: row.placed_at.toISOString(),
        total_minor: row.total_minor,
        item_count: row.item_count,
      }));
    });
  }

  // ------------------------------------------------------------------ rewards

  /** The customer's points and where they came from, from the counter and the website alike. */
  async rewards(shop: ShopClient, session: CustomerSession): Promise<ShopRewards> {
    return this.db.withOrg(shop.orgId, (tx) => this.rewardsTx(tx, session.customerId));
  }

  /** Text a code to a phone number, to prove it and link it to the shop's rewards. */
  async requestPhoneCode(shop: ShopClient, session: CustomerSession, rawPhone: string): Promise<ShopPhoneCodeSent> {
    const phone = normalizeUsPhone(rawPhone);
    if (!phone) {
      throw new ApiException('validation_failed', 'Enter a US mobile number.', { retryable: false });
    }
    await this.sendPhoneCode(shop, session.customerId, phone);
    return { status: 'code_sent', phone_hint: phoneHint(phone), expires_in_seconds: PHONE_CODE_MINUTES * 60 };
  }

  /**
   * Check a texted code, and if it is right, make the phone the account's own.
   *
   * When that number already belongs to someone in the shop's rewards -- a
   * customer the register knows by it -- the account becomes that customer:
   * one record, one set of points, one history. When it belongs to another
   * online account, nothing changes and the customer is told to sign in to
   * that one.
   */
  async confirmPhoneCode(shop: ShopRequestContext, session: CustomerSession, code: string): Promise<ShopPhoneVerified> {
    // Decided inside, acted on after commit: a wrong guess has to count even
    // though the answer is an error.
    const outcome = await this.db.withOrg(shop.orgId, async (tx): Promise<PhoneOutcome> => {
      const { rows } = await tx.query<{ id: string; detail: { phone: string; code_hash: string; attempts?: number } }>(
        `SELECT id, detail FROM customer_tokens
         WHERE customer_id = $1 AND purpose = 'verify_phone' AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [session.customerId],
      );
      const token = rows[0];
      if (!token) return { kind: 'expired' };

      if (!this.phoneCodes.matches(token.detail.phone, code, token.detail.code_hash)) {
        const attempts = (token.detail.attempts ?? 0) + 1;
        await tx.query(
          `UPDATE customer_tokens
              SET detail = jsonb_set(detail, '{attempts}', to_jsonb($2::int)),
                  used_at = CASE WHEN $2::int >= $3::int THEN now() ELSE used_at END
            WHERE id = $1`,
          [token.id, attempts, PHONE_CODE_ATTEMPTS],
        );
        return attempts >= PHONE_CODE_ATTEMPTS ? { kind: 'expired' } : { kind: 'wrong', left: PHONE_CODE_ATTEMPTS - attempts };
      }
      await tx.query(`UPDATE customer_tokens SET used_at = now() WHERE id = $1`, [token.id]);

      const phone = token.detail.phone;
      const { rows: holders } = await tx.query<{ id: string; active: boolean; has_account: boolean }>(
        `SELECT c.id, (c.status = 'active' AND c.anonymized_at IS NULL) AS active,
                (cc.customer_id IS NOT NULL) AS has_account
         FROM customers c LEFT JOIN customer_credentials cc ON cc.customer_id = c.id
         WHERE c.phone = $1 AND c.id <> $2
         FOR UPDATE OF c`,
        [phone, session.customerId],
      );
      const holder = holders[0];

      let customerId = session.customerId;
      let linked = false;
      if (holder) {
        if (holder.has_account) return { kind: 'taken' };
        if (!holder.active) return { kind: 'closed' };
        customerId = await this.mergeTx(tx, shop, session.customerId, holder.id);
        linked = true;
      } else {
        await tx.query(`UPDATE customers SET phone = $2 WHERE id = $1`, [session.customerId, phone]);
      }

      await tx.query(
        `UPDATE customer_credentials SET verified_phone = $2, phone_verified_at = now() WHERE customer_id = $1`,
        [customerId, phone],
      );
      return { kind: 'ok', customerId, linked };
    });

    switch (outcome.kind) {
      case 'expired':
        throw new ApiException('validation_failed', 'That code has expired. Ask for a new one.', { retryable: false });
      case 'wrong':
        throw new ApiException(
          'validation_failed',
          `That code isn't right. You have ${outcome.left} ${outcome.left === 1 ? 'try' : 'tries'} left.`,
          { retryable: false },
        );
      case 'taken':
        throw new ApiException(
          'conflict',
          'That number is already on another online account. Sign in to that account instead, or call the shop.',
          { retryable: false },
        );
      case 'closed':
        throw new ApiException('conflict', 'That number is on a record the shop has closed. Call the shop to reopen it.', {
          retryable: false,
        });
      case 'ok':
        return {
          status: 'verified',
          linked_in_store_rewards: outcome.linked,
          rewards: await this.db.withOrg(shop.orgId, (tx) => this.rewardsTx(tx, outcome.customerId)),
        };
    }
  }

  // ------------------------------------------------------------------ private

  private async sendPhoneCode(shop: ShopClient, customerId: string, phone: string): Promise<void> {
    const code = await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows: verified } = await tx.query<{ same: boolean }>(
        `SELECT (cc.verified_phone = $2 AND c.phone = $2) AS same
         FROM customer_credentials cc JOIN customers c ON c.id = cc.customer_id WHERE cc.customer_id = $1`,
        [customerId, phone],
      );
      if (verified[0]?.same) {
        throw new ApiException('conflict', "That number is already verified on your account.", { retryable: false });
      }

      // Counted across every account for the phone as well as this account's
      // own requests, so the form cannot be used to flood someone's phone.
      const { rows: recent } = await tx.query<{ mine: number; to_phone: number; last_seconds: number | null }>(
        `SELECT count(*) FILTER (WHERE customer_id = $1)::int AS mine,
                count(*) FILTER (WHERE detail->>'phone' = $2)::int AS to_phone,
                extract(epoch FROM now() - max(created_at) FILTER (WHERE customer_id = $1))::int AS last_seconds
         FROM customer_tokens
         WHERE purpose = 'verify_phone' AND created_at > now() - interval '1 hour'`,
        [customerId, phone],
      );
      const counts = recent[0]!;
      if (counts.mine >= PHONE_CODES_PER_HOUR || counts.to_phone >= PHONE_CODES_PER_HOUR) {
        throw new ApiException('rate_limited', 'Too many codes asked for. Try again in an hour.', { retryable: true });
      }
      if (counts.last_seconds !== null && counts.last_seconds < PHONE_CODE_EVERY_SECONDS) {
        throw new ApiException('rate_limited', 'Wait a minute before asking for another code.', { retryable: true });
      }

      // One live code at a time. Asking again retires the last one.
      await tx.query(
        `UPDATE customer_tokens SET used_at = now()
         WHERE customer_id = $1 AND purpose = 'verify_phone' AND used_at IS NULL`,
        [customerId],
      );
      const issued = this.phoneCodes.issue(phone);
      await tx.query(
        `INSERT INTO customer_tokens (org_id, customer_id, purpose, token_hash, detail, expires_at)
         VALUES (current_setting('app.org_id')::uuid, $1, 'verify_phone', $2, $3::jsonb,
                 now() + make_interval(mins => $4))`,
        [
          customerId,
          hashSecret(randomBytes(32).toString('base64url')),
          JSON.stringify({ phone, code_hash: issued.hash, attempts: 0 }),
          PHONE_CODE_MINUTES,
        ],
      );
      return issued.code;
    });

    // No product and no shop name in it: carriers filter texts that mention
    // tobacco or vaping, and a code that never arrives is worse than a plain one.
    await this.texter.send('phone-code', {
      to: phone,
      body: `Your verification code is ${code}. It expires in ${PHONE_CODE_MINUTES} minutes. If you didn't ask for it, ignore this text.`,
    });
  }

  /**
   * Make two customer records one: everything the online account had moves to
   * the in-store record the register already knows by phone, and the empty
   * online record is closed and scrubbed.
   *
   * The account's sign-in email goes with it, since that is the address the
   * customer proved and signs in with. If that replaces a different email the
   * shop had on file, any email-marketing consent is withdrawn: it was given
   * for another address, and the customer can give it again from their account.
   */
  private async mergeTx(tx: PoolClient, shop: ShopRequestContext, fromId: string, intoId: string): Promise<string> {
    const { rows: from } = await tx.query<{ email: string | null; first_name: string | null; last_name: string | null }>(
      `SELECT email, first_name, last_name FROM customers WHERE id = $1 FOR UPDATE`,
      [fromId],
    );
    const { rows: into } = await tx.query<{ email: string | null }>(`SELECT email FROM customers WHERE id = $1 FOR UPDATE`, [
      intoId,
    ]);
    const account = from[0]!;
    const previousEmail = into[0]?.email ?? null;

    for (const table of [
      'customer_credentials',
      'customer_sessions',
      'customer_tokens',
      'carts',
      'orders',
      'sales',
      'refunds',
      'loyalty_ledger',
      'customer_consents',
    ]) {
      await tx.query(`UPDATE ${table} SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId]);
    }

    // The online record gives up its email first: an email may be on only one record.
    await tx.query(
      `UPDATE customers
          SET email = NULL, phone = NULL, first_name = NULL, last_name = NULL, anonymized_at = now(),
              status = 'archived', notes = 'Merged into another customer record when the customer linked their online account.'
        WHERE id = $1`,
      [fromId],
    );
    await tx.query(
      `UPDATE customers
          SET email = COALESCE($2, email), first_name = COALESCE(first_name, $3), last_name = COALESCE(last_name, $4)
        WHERE id = $1`,
      [intoId, account.email, account.first_name, account.last_name],
    );

    if (account.email && previousEmail && previousEmail.toLowerCase() !== account.email.toLowerCase()) {
      const { rows: consent } = await tx.query<{ granted: boolean }>(
        `SELECT granted FROM customer_consents WHERE customer_id = $1 AND channel = 'email'
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [intoId],
      );
      if (consent[0]?.granted) {
        await this.recordConsent(tx, shop, intoId, false, 'web_account', {
          reason: 'email address on file changed when the online account was linked; consent was for the previous address',
        });
      }
    }

    await this.audit.record(tx, {
      action: 'customer.merged',
      entityType: 'customer',
      entityId: intoId,
      actorType: 'customer',
      oldValue: { merged_customer_id: fromId, email_changed: previousEmail !== null && previousEmail !== account.email },
      reason: 'linked online account by verified phone',
    });
    return intoId;
  }

  private async rewardsTx(tx: PoolClient, customerId: string): Promise<ShopRewards> {
    const settings = await this.loyalty.settingsTx(tx);
    const balance = await this.loyalty.balanceTx(tx, customerId);
    const entries = await this.loyalty.entriesTx(tx, customerId, 20);
    const { rows } = await tx.query<{ phone: string | null; verified: boolean }>(
      `SELECT c.phone, (cc.verified_phone IS NOT NULL AND cc.verified_phone = c.phone) AS verified
       FROM customers c LEFT JOIN customer_credentials cc ON cc.customer_id = c.id WHERE c.id = $1`,
      [customerId],
    );
    return {
      program_name: settings.name,
      active: settings.is_active,
      points: balance.points,
      lifetime_earned: balance.lifetimeEarned,
      points_per_dollar: settings.earn_rate,
      value_minor: pointsValueMinor(balance.points, settings.redemption_rate).toString(),
      phone: rows[0]?.phone ?? null,
      phone_verified: rows[0]?.verified === true,
      activity: entries.map((entry) => ({
        kind: entry.kind,
        points: entry.points,
        label:
          entry.kind === 'earn'
            ? entry.channel === 'in_store'
              ? `In store, receipt ${entry.receipt_no}`
              : `Online order ${entry.receipt_no}`
            : entry.kind === 'reverse'
              ? entry.refund_id
                ? `Returned items, ${entry.receipt_no}`
                : `Cancelled sale, ${entry.receipt_no}`
              : entry.kind === 'redeem'
                ? 'Spent'
                : entry.kind === 'expire'
                  ? 'Expired'
                  : (entry.note ?? 'Adjusted by the shop'),
        at: entry.occurred_at,
      })),
    };
  }

  private async findAccount(tx: PoolClient, email: string): Promise<AccountRow | null> {
    const { rows } = await tx.query<AccountRow>(
      `SELECT c.id AS customer_id, c.email, c.first_name, c.last_name,
              cc.password_hash, cc.email_verified_at, cc.failed_attempts, cc.locked_until,
              (c.status = 'active' AND c.anonymized_at IS NULL) AS active
       FROM customers c
       LEFT JOIN customer_credentials cc ON cc.customer_id = c.id
       WHERE lower(c.email) = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  private async profileTx(tx: PoolClient, customerId: string): Promise<ShopCustomerProfile> {
    const { rows } = await tx.query<{
      first_name: string | null;
      last_name: string | null;
      email: string;
      phone: string | null;
      phone_verified: boolean;
      marketing_email: boolean | null;
      pending_phone: string | null;
    }>(
      `SELECT c.first_name, c.last_name, c.email, c.phone,
              (cc.verified_phone IS NOT NULL AND cc.verified_phone = c.phone) AS phone_verified,
              (SELECT consent.granted FROM customer_consents consent
                WHERE consent.customer_id = c.id AND consent.channel = 'email'
                ORDER BY consent.occurred_at DESC, consent.id DESC LIMIT 1) AS marketing_email,
              (SELECT t.detail->>'phone' FROM customer_tokens t
                WHERE t.customer_id = c.id AND t.purpose = 'verify_phone' AND t.used_at IS NULL AND t.expires_at > now()
                ORDER BY t.created_at DESC LIMIT 1) AS pending_phone
       FROM customers c LEFT JOIN customer_credentials cc ON cc.customer_id = c.id
       WHERE c.id = $1`,
      [customerId],
    );
    const row = rows[0];
    if (!row) throw new ApiException('unauthenticated', 'sign in to continue');
    return {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
      phone_verified: row.phone_verified === true,
      marketing_email: row.marketing_email === true,
      pending_phone_hint: row.pending_phone ? phoneHint(row.pending_phone) : null,
    };
  }

  private async startSession(tx: PoolClient, customerId: string): Promise<ShopSession> {
    const session = await this.sessions.createTx(tx, customerId);
    return {
      session_token: session.token,
      expires_at: session.expiresAt,
      customer: await this.profileTx(tx, customerId),
    };
  }

  private async issueToken(
    tx: PoolClient,
    customerId: string,
    purpose: 'verify_email' | 'reset_password',
    minutes: number,
    detail: Record<string, unknown>,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await tx.query(
      `INSERT INTO customer_tokens (org_id, customer_id, purpose, token_hash, detail, expires_at)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4::jsonb, now() + make_interval(mins => $5))`,
      [customerId, purpose, hashSecret(token), JSON.stringify(detail), minutes],
    );
    return token;
  }

  /** Spend a one-time token, or refuse with the one sentence that covers every way it can be no good. */
  private async useToken(
    tx: PoolClient,
    token: string,
    purpose: 'verify_email' | 'reset_password',
  ): Promise<{ id: string; customer_id: string; detail: Record<string, unknown> }> {
    const { rows } = await tx.query<{ id: string; customer_id: string; detail: Record<string, unknown> }>(
      `SELECT t.id, t.customer_id, t.detail
       FROM customer_tokens t
       JOIN customers c ON c.id = t.customer_id AND c.status = 'active' AND c.anonymized_at IS NULL
       WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now()
       FOR UPDATE OF t`,
      [hashSecret(token), purpose],
    );
    const row = rows[0];
    if (!row) {
      throw new ApiException(
        'validation_failed',
        'This link has expired or has already been used. Ask for a new one.',
        { retryable: false },
      );
    }
    await tx.query(`UPDATE customer_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    return row;
  }

  /** Whether an email of this kind already went to this customer in the last minute. */
  private async throttled(
    tx: PoolClient,
    customerId: string,
    purpose: 'verify_email' | 'reset_password',
  ): Promise<boolean> {
    const { rows } = await tx.query<{ recent: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM customer_tokens
         WHERE customer_id = $1 AND purpose = $2 AND created_at > now() - make_interval(secs => $3)
       ) AS recent`,
      [customerId, purpose, EMAIL_EVERY_SECONDS],
    );
    return rows[0]?.recent === true;
  }

  private async recordConsent(
    tx: PoolClient,
    shop: ShopRequestContext,
    customerId: string,
    granted: boolean,
    source: 'web_signup' | 'web_account',
    evidence: Record<string, unknown>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO customer_consents (org_id, customer_id, channel, granted, source, evidence)
       VALUES (current_setting('app.org_id')::uuid, $1, 'email', $2, $3, $4::jsonb)`,
      [
        customerId,
        granted,
        source,
        JSON.stringify({ ...evidence, ip: shop.shopperIp, user_agent: shop.userAgent ?? null }),
      ],
    );
  }

  private async shopName(tx: PoolClient): Promise<string> {
    const { rows } = await tx.query<{ display_name: string }>(
      `SELECT display_name FROM organizations WHERE id = current_setting('app.org_id')::uuid`,
    );
    return rows[0]?.display_name ?? 'the shop';
  }

  private refuseEmailAsPassword(email: string, password: string): void {
    if (password.trim().toLowerCase() === email.trim().toLowerCase()) {
      throw new ApiException('validation_failed', "Your password can't be your email address.", {
        retryable: false,
      });
    }
  }

  private async send(kind: string, to: string, message: EmailContent): Promise<void> {
    await this.mailer.send(kind, { to, subject: message.subject, body: message.body });
  }
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
