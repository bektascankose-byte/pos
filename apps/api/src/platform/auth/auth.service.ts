import { Injectable, Logger } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { TokenService } from './token.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { ApiException } from '../errors/api-exception.js';

/**
 * OWASP's recommended Argon2id baseline. Deliberately slow: roughly 50ms per
 * verification, which is invisible to a person signing in once and ruinous to
 * anyone working through a leaked password list.
 */
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * PINs are hashed with the same algorithm but far cheaper parameters, because a
 * cashier unlocks a register hundreds of times a shift and 50ms each time is
 * felt at a counter. A four digit PIN has 10,000 possibilities, so hashing cost
 * was never what protected it — lockout after five failures is. The PIN is a
 * second factor on an already claimed device, not a password.
 */
const ARGON_PIN = { memoryCost: 4_096, timeCost: 2, parallelism: 1 } as const;

const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MINUTES = 15;

/**
 * How long a reset link lives. Long enough to walk to a computer and find the
 * email, short enough that one left in an inbox is not a standing key. It is
 * also stated in the email, so nobody is surprised by a dead link.
 */
const RESET_TOKEN_MINUTES = 60;

/**
 * Only the hash is stored, so the database never holds anything that opens an
 * account. SHA-256 rather than Argon2 here on purpose: this is a 256 bit
 * random value, not a password, so there is nothing to brute force and no
 * reason to pay Argon2's cost on a lookup -- the same reasoning as the
 * refresh session hashes in migration 0007.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AuthenticatedUser {
  userId: string;
  orgId: string;
  storeId: string | null;
  registerId: string | null;
  displayName: string;
  permissions: string[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokenService,
    private readonly mailer: MailerService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return hash(password, ARGON);
  }

  hashPin(pin: string): Promise<string> {
    return hash(pin, ARGON_PIN);
  }

  /**
   * Sign in with email and password.
   *
   * Goes through `auth_lookup_user`, a SECURITY DEFINER function, rather than
   * selecting from `users` directly. RLS denies when `app.org_id` is unset, and
   * at login there is no org to set yet: it is not known until the user is
   * found. Rather than weakening the policy or connecting as a role that
   * bypasses it, the one genuinely cross tenant read in the system is confined
   * to a function with a fixed column list. See migration 0007.
   */
  async login(
    email: string,
    password: string,
    context: { deviceId?: string | undefined; userAgent?: string | undefined; ip?: string | undefined } = {},
  ) {
    const row = await this.db.unscoped(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        password_hash: string | null;
        display_name: string | null;
        full_name: string;
      }>(`SELECT * FROM auth_lookup_user($1)`, [email]);
      return rows[0];
    });

    // Hash a dummy value when the user does not exist so that a missing account
    // and a wrong password take the same time. Otherwise response latency
    // enumerates valid email addresses.
    if (!row?.password_hash) {
      await verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c25hcHBvcw$Y2Fubm90bWF0Y2hhbnl0aGluZ2F0YWxs',
        password,
        ARGON,
      ).catch(() => false);
      throw new ApiException('invalid_credentials', 'invalid email or password');
    }

    const ok = await verify(row.password_hash, password, ARGON).catch(() => false);
    if (!ok) throw new ApiException('invalid_credentials', 'invalid email or password');

    return this.issueSession(row.org_id, row.id, row.display_name ?? row.full_name, {
      ...context,
      familyId: randomUUID(),
    });
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that has already been rotated means two parties hold it,
   * which means one of them stole it. There is no way to tell which, so the
   * whole family is revoked and both are signed out. A legitimate user
   * re-authenticating is a far better outcome than an attacker keeping a
   * session alive indefinitely.
   */
  async refresh(
    refreshToken: string,
    context: { userAgent?: string | undefined; ip?: string | undefined } = {},
  ) {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    const session = await this.db.unscoped(async (client) => {
      const { rows } = await client.query<{
        id: string;
        org_id: string;
        user_id: string;
        family_id: string;
        device_id: string | null;
        rotated_at: Date | null;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT * FROM auth_lookup_session($1)`,
        [tokenHash],
      );
      return rows[0];
    });

    if (!session) throw new ApiException('unauthenticated', 'unknown refresh token');

    if (session.rotated_at || session.revoked_at) {
      await this.revokeFamily(session.org_id, session.family_id, 'reuse_detected');
      this.logger.warn(
        { userId: session.user_id, familyId: session.family_id },
        'refresh token reuse detected; family revoked',
      );
      throw new ApiException('unauthenticated', 'refresh token was already used; sign in again');
    }

    if (session.expires_at.getTime() <= Date.now()) {
      throw new ApiException('unauthenticated', 'refresh token expired');
    }

    const user = await this.db.withOrg(session.org_id, async (tx) => {
      const { rows } = await tx.query<{ display_name: string | null; full_name: string }>(
        `SELECT display_name, full_name FROM users WHERE id = $1 AND status = 'active'`,
        [session.user_id],
      );
      return rows[0];
    });
    if (!user) throw new ApiException('unauthenticated', 'account is no longer active');

    await this.db.withOrg(session.org_id, async (tx) => {
      await tx.query(`UPDATE auth_sessions SET rotated_at = now() WHERE id = $1`, [session.id]);
    });

    return this.issueSession(
      session.org_id,
      session.user_id,
      user.display_name ?? user.full_name,
      { ...context, familyId: session.family_id, deviceId: session.device_id ?? undefined },
    );
  }

  async logout(orgId: string, refreshToken: string): Promise<void> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `UPDATE auth_sessions
         SET revoked_at = now(), revoked_reason = 'logout'
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
    });
  }

  /**
   * Verify a manager's PIN for a single privileged action.
   *
   * Checked live against the database rather than against the requesting user's
   * token, so a manager whose access was revoked five minutes ago cannot
   * approve a refund on a register that has not refreshed yet.
   */
  async verifyPin(
    orgId: string,
    userId: string,
    pin: string,
  ): Promise<{ ok: boolean; lockedUntil: Date | null }> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        pin_hash: string;
        failed_count: number;
        locked_until: Date | null;
      }>(
        `SELECT pin_hash, failed_count, locked_until FROM employee_pins
         WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const record = rows[0];
      if (!record) return { ok: false, lockedUntil: null };

      if (record.locked_until && record.locked_until.getTime() > Date.now()) {
        return { ok: false, lockedUntil: record.locked_until };
      }

      const ok = await verify(record.pin_hash, pin, ARGON_PIN).catch(() => false);

      if (ok) {
        await tx.query(
          `UPDATE employee_pins SET failed_count = 0, locked_until = NULL WHERE user_id = $1`,
          [userId],
        );
        return { ok: true, lockedUntil: null };
      }

      // Four digits is 10,000 combinations. Lockout, not hashing cost, is what
      // makes that acceptable.
      const failures = record.failed_count + 1;
      const lock = failures >= MAX_PIN_FAILURES;
      await tx.query(
        `UPDATE employee_pins
         SET failed_count = $2,
             locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
         WHERE user_id = $1`,
        [userId, lock ? 0 : failures, lock, String(PIN_LOCKOUT_MINUTES)],
      );

      return {
        ok: false,
        lockedUntil: lock ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60_000) : null,
      };
    });
  }

  /** Effective permissions: the union across every role granted to the user. */
  async permissionsFor(orgId: string, userId: string): Promise<string[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ permission_key: string }>(
        `SELECT DISTINCT rp.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1`,
        [userId],
      );
      return rows.map((r) => r.permission_key);
    });
  }

  private async issueSession(
    orgId: string,
    userId: string,
    displayName: string,
    context: {
      familyId: string;
      deviceId?: string | undefined;
      userAgent?: string | undefined;
      ip?: string | undefined;
    },
  ) {
    const permissions = await this.permissionsFor(orgId, userId);
    const { token: refreshToken, hash: tokenHash } = this.tokens.mintRefreshToken();
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);

    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO auth_sessions
           (org_id, user_id, family_id, token_hash, device_id, user_agent, ip, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          orgId,
          userId,
          context.familyId,
          tokenHash,
          context.deviceId ?? null,
          context.userAgent ?? null,
          context.ip ?? null,
          expiresAt,
        ],
      );
      await tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    });

    const { token, expiresIn } = await this.tokens.issueAccessToken({
      sub: userId,
      org: orgId,
      store: null,
      register: null,
      perms: permissions,
    });

    return {
      access_token: token,
      expires_in: expiresIn,
      refresh_token: refreshToken,
      token_type: 'Bearer' as const,
      session: { userId, orgId, displayName, permissions },
    };
  }

  /**
   * Start a password reset.
   *
   * Always answers the same, whatever happened. An unknown address, a
   * suspended account and a mail server that was down all look identical from
   * outside, because the alternative is a form that tells a stranger which
   * email addresses have accounts here. What actually happened goes to the
   * log instead, which is where somebody investigating "I never got it" will
   * look.
   *
   * The raw token is generated here, hashed before it touches the database,
   * and then exists only inside the email. Nothing can read it back out
   * afterwards -- not a database dump, not a query log, not this method twice.
   */
  async requestPasswordReset(
    email: string,
    context: { ip?: string | undefined; userAgent?: string | undefined; resetUrlBase: string },
  ): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000);

    const found = await this.db.unscoped(async (client) => {
      const { rows } = await client.query<{ user_id: string; email: string; full_name: string }>(
        `SELECT * FROM auth_create_password_reset($1, $2, $3, $4, $5)`,
        [email, hashToken(token), expiresAt, context.ip ?? null, context.userAgent ?? null],
      );
      return rows[0];
    });

    if (!found) {
      this.logger.log(`password reset asked for an address with no active account`);
      return;
    }

    const link = `${context.resetUrlBase.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

    // Deliberately not awaited. Talking to a mail server takes seconds, and
    // awaiting it would make a request for a real address visibly slower than
    // one for an address with no account -- handing back, as a stopwatch
    // reading, exactly the answer the identical response bodies above exist to
    // withhold. The caller gets the same quick `ok` either way and the send
    // finishes on its own; `MailerService.send` never throws and logs its own
    // failures, so nothing is lost but the wait.
    void this.mailer.send({
      to: found.email,
      subject: 'Reset your SnapPOS password',
      text: [
        `Hello ${found.full_name},`,
        '',
        'Someone asked to reset the password on your SnapPOS back office account.',
        'Open this link to choose a new one:',
        '',
        link,
        '',
        `The link works once and stops working in ${RESET_TOKEN_MINUTES} minutes.`,
        '',
        'If this was not you, ignore this email. Your password has not changed,',
        'and nobody can get in without the link above.',
      ].join('\n'),
    }).then((sent) => {
      if (!sent.ok) {
        this.logger.error(`password reset for ${found.email} could not be emailed: ${sent.error}`);
      } else {
        this.logger.log(`password reset link emailed to ${found.email}`);
      }
    });
  }

  /**
   * Finish a password reset.
   *
   * The token is spent inside `auth_consume_password_reset`, in the same
   * statement that checks it, so two people racing the same link cannot both
   * get through. Unknown, expired and already used come back the same way and
   * are reported the same way, because telling someone which of the three it
   * was is telling them something about a token they do not hold.
   *
   * Every existing session is revoked on success. Somebody resetting a
   * password has either forgotten it or suspects somebody else has it, and in
   * the second case leaving the intruder's session alive would make the reset
   * pointless.
   */
  async completePasswordReset(token: string, password: string): Promise<void> {
    const claim = await this.db.unscoped(async (client) => {
      const { rows } = await client.query<{ user_id: string; org_id: string }>(
        `SELECT * FROM auth_consume_password_reset($1)`,
        [hashToken(token)],
      );
      return rows[0];
    });

    if (!claim) {
      throw new ApiException(
        'invalid_credentials',
        'that reset link has expired or has already been used -- ask for a new one',
        { retryable: false },
      );
    }

    const passwordHash = await this.hashPassword(password);
    await this.db.withOrg(claim.org_id, async (tx) => {
      await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
        claim.user_id,
        passwordHash,
      ]);
      await tx.query(
        `UPDATE auth_sessions
         SET revoked_at = now(), revoked_reason = 'password_reset'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [claim.user_id],
      );
    });

    this.logger.log(`password reset completed for user ${claim.user_id}`);
  }

  private async revokeFamily(orgId: string, familyId: string, reason: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `UPDATE auth_sessions
         SET revoked_at = now(), revoked_reason = $2
         WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId, reason],
      );
    });
  }
}
