/**
 * Sales, payments, refunds and cash.
 *
 * These are the financial records. Everything here is append only: a void is a
 * new state on the sale, a correction is a new row, and nothing is ever edited
 * in place. The database enforces that with triggers rather than trusting this
 * layer, but the shapes below are designed so the honest path is also the
 * convenient one.
 *
 * The register composes a whole sale offline and uploads it as one envelope.
 * There is no "create sale then add lines" sequence, because a half uploaded
 * sale over a flaky connection is exactly the failure this design exists to
 * make impossible.
 */

import { z } from 'zod';
import {
  uuid,
  uuidV7,
  moneyMinor,
  moneyNonNegative,
  quantity,
  costDecimal,
  timestamp,
  deviceTime,
  barcode,
  pagination,
} from './primitives.js';

export const saleStatus = z.enum(['parked', 'completed', 'voided']);
export const saleChannel = z.enum(['in_store', 'pickup', 'delivery', 'online']);
export const paymentMethod = z.enum([
  'cash',
  'card',
  'gift_card',
  'store_credit',
  'external',
  'check',
  'other',
]);
export const paymentStatus = z.enum([
  'pending',
  'authorized',
  'captured',
  'failed',
  'voided',
  'refunded',
]);

// ---------------------------------------------------------------------- lines

/**
 * A sale line, as it was at the moment of sale.
 *
 * Almost everything here is a snapshot: description, SKU, price, cost, tax
 * breakdown, promotion ids and the compliance rule that applied. A report run
 * next year must show what the customer actually paid and what it actually
 * cost, not what the catalog says today. Repricing a product must never rewrite
 * a sale.
 */
export const saleLineInput = z.object({
  /** Register generated UUIDv7. Doubles as the inventory ledger id for this line. */
  id: uuidV7,
  line_no: z.number().int().min(1).max(999),
  variant_id: uuid,
  description: z.string().min(1).max(256),
  sku_snapshot: z.string().min(1).max(64),
  /** Which barcode was actually scanned, when one was. Useful for loss prevention. */
  barcode_scanned: barcode.optional(),
  /** Signed and non zero. Negative is a line level return within a sale. */
  quantity,
  unit_price_minor: moneyNonNegative,
  /** What the catalog said, before any override. Their difference is the variance. */
  original_price_minor: moneyNonNegative,
  price_overridden: z.boolean().default(false),
  /** The manager who authorized the override. Required when price_overridden. */
  override_by: uuid.optional(),
  override_reason: z.string().max(256).optional(),
  discount_minor: moneyNonNegative.default('0'),
  tax_minor: moneyMinor,
  total_minor: moneyMinor,
  unit_cost: costDecimal.default('0'),
  /** Per rate breakdown, so a tax report can be rebuilt without re-deriving it. */
  tax_snapshot: z.array(z.record(z.unknown())).default([]),
  promotion_ids: z.array(uuid).default([]),
  /** The age rule that applied, as it read at the time. */
  compliance_snapshot: z.record(z.unknown()).default({}),
});

// ------------------------------------------------------------------- payments

/**
 * A tender. Several per sale is normal: cash plus card, two cards, a gift card
 * and the balance in cash.
 *
 * `provider_token` is the only thing ever stored for a card. There is no field
 * for a PAN anywhere in this system, and `card_last4` is four characters wide,
 * so there is nowhere to put one even by mistake.
 */
export const paymentInput = z
  .object({
    id: uuidV7,
    method: paymentMethod,
    status: paymentStatus.default('captured'),
    amount_minor: moneyMinor,
    /** What the customer handed over. Cash only; change is the difference. */
    tendered_minor: moneyMinor.optional(),
    change_minor: moneyNonNegative.default('0'),
    tip_minor: moneyNonNegative.default('0'),
    provider: z.string().max(64).optional(),
    provider_payment_id: z.string().max(128).optional(),
    provider_token: z.string().max(256).optional(),
    card_last4: z.string().regex(/^\d{4}$/).optional(),
    card_brand: z.string().max(32).optional(),
    entry_mode: z.string().max(32).optional(),
    auth_code: z.string().max(32).optional(),
    terminal_serial: z.string().max(64).optional(),
    device_time: deviceTime,
  })
  .superRefine((p, ctx) => {
    // A cash tender has no provider token. The database enforces this too; it is
    // repeated here so the register gets a field level error rather than a 500.
    if (p.method === 'cash' && p.provider_token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider_token'],
        message: 'a cash payment cannot carry a provider token',
      });
    }
    if (p.method === 'cash' && p.tendered_minor !== undefined) {
      const expectedChange = p.tendered_minor - p.amount_minor;
      if (expectedChange !== p.change_minor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['change_minor'],
          message: `tendered minus amount is ${expectedChange}, but change is ${p.change_minor}`,
        });
      }
    }
  });

// --------------------------------------------------------------- verification

/**
 * An age check. Metadata only, by design.
 *
 * There is no field here for a name, a date of birth, a licence number or an
 * image, and there is none in the table either. The only reliable way to
 * guarantee identity data is not retained is to have nowhere to put it.
 */
export const ageVerificationInput = z.object({
  id: uuidV7,
  sale_line_id: uuid.optional(),
  method: z.enum(['scan', 'manual', 'provider', 'exempt']),
  result: z.enum(['pass', 'fail', 'expired_id', 'unreadable', 'refused']),
  minimum_age_applied: z.number().int().min(0).max(120),
  provider: z.string().max(64).optional(),
  provider_token: z.string().max(256).optional(),
  verified_at: timestamp,
});

// ----------------------------------------------------------------- the sale

/**
 * A complete sale, uploaded as one envelope.
 *
 * The register computed all of this offline and the customer has already left.
 * The server's job is to record it, not to approve it: see the arithmetic note
 * on `subtotal_minor` below.
 */
export const saleInput = z
  .object({
    id: uuidV7,
    store_id: uuid,
    register_id: uuid,
    device_id: uuid.optional(),
    session_id: uuid.optional(),
    cashier_user_id: uuid,
    customer_id: uuid.optional(),

    /**
     * Composite and printable with no network: `{store}-{register}-{sequence}`.
     * A global sequence would need a number server, and a number server is a
     * thing that can be unreachable while a customer waits.
     */
    receipt_no: z.string().min(1).max(64),
    register_sequence: z.number().int().min(1),

    channel: saleChannel.default('in_store'),
    status: saleStatus.default('completed'),

    /**
     * Totals as the register computed them, which is what the customer paid.
     *
     * The server recomputes these from the lines and records any difference as
     * `price_variance_minor`, but it does NOT reject a mismatch. A completed
     * sale is a fact about money that already changed hands; refusing the record
     * does not undo it, it only hides the discrepancy. The variance is surfaced
     * as an alert instead, which is both honest and actionable.
     */
    subtotal_minor: moneyMinor,
    discount_minor: moneyNonNegative.default('0'),
    tax_minor: moneyMinor,
    tip_minor: moneyNonNegative.default('0'),
    total_minor: moneyMinor,

    tax_exempt: z.boolean().default(false),
    tax_exempt_reason: z.string().max(256).optional(),
    note: z.string().max(1024).optional(),

    device_time: deviceTime,
    completed_at: timestamp.optional(),

    lines: z.array(saleLineInput).min(1).max(500),
    payments: z.array(paymentInput).default([]),
    age_verifications: z.array(ageVerificationInput).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.status === 'completed' && !s.completed_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'a completed sale must carry the time it completed',
      });
    }
    if (s.tax_exempt && !s.tax_exempt_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tax_exempt_reason'],
        message: 'a tax exempt sale must record why',
      });
    }
    const lineNumbers = s.lines.map((l) => l.line_no);
    if (new Set(lineNumbers).size !== lineNumbers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'duplicate line_no',
      });
    }
    for (const [i, line] of s.lines.entries()) {
      if (line.price_overridden && !line.override_by) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', i, 'override_by'],
          message: 'a price override must record who authorized it',
        });
      }
    }
    // A completed sale must be paid for. Parked sales are the exception: they
    // are a held basket, not a transaction.
    if (s.status === 'completed' && s.payments.length === 0 && s.total_minor !== 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payments'],
        message: 'a completed sale with a non zero total needs at least one tender',
      });
    }
  });

export const voidSaleSchema = z.object({
  reason: z.string().min(3).max(256),
});

/**
 * A void composed on a register and delivered through the sync batch.
 *
 * Separate from `voidSaleSchema` because the two arrive by different routes and
 * carry different authority. Over HTTP the caller is the actor and the guard
 * checks their own `sale.void`. From a register the uploader is the cashier's
 * token, and the manager who authorised it at the counter is named here — so
 * `approved_by` is required rather than optional. A void with nobody's name on
 * it is indistinguishable from a cashier deleting their own mistake, or their
 * own theft, after the fact.
 *
 * `id` is the void's own UUIDv7, not the sale's: it is the idempotency key, and
 * a replay of the same delivery has to be recognisable as the same void.
 */
export const saleVoidInput = z.object({
  id: uuidV7,
  sale_id: uuid,
  approved_by: uuid,
  cashier_user_id: uuid,
  reason: z.string().min(3).max(256),
  device_time: z.string().datetime({ offset: true }),
});

export type SaleVoidInput = z.infer<typeof saleVoidInput>;

// -------------------------------------------------------------------- refunds

/**
 * A refund against an original sale.
 *
 * `sale_line_id` ties each refunded line back to what was sold, which is what
 * makes it possible to refuse refunding four of something that was sold in a
 * quantity of three. Refunds with no original are permitted but gated behind a
 * separate permission, because they are the single most common vector for
 * employee theft in retail.
 */
export const refundLineInput = z.object({
  id: uuidV7,
  sale_line_id: uuid.optional(),
  variant_id: uuid,
  description: z.string().min(1).max(256),
  quantity,
  unit_price_minor: moneyNonNegative,
  tax_minor: moneyMinor.default('0'),
  total_minor: moneyMinor,
  unit_cost: costDecimal.default('0'),
  /**
   * Whether the item goes back on the shelf. A returned drink that has been
   * opened is refunded but not restocked, and inventory must reflect that or
   * the count drifts by exactly the number of damaged returns.
   */
  restocked: z.boolean().default(true),
  condition: z.string().max(64).optional(),
});

export const refundInput = z
  .object({
    id: uuidV7,
    store_id: uuid,
    register_id: uuid,
    session_id: uuid.optional(),
    original_sale_id: uuid.optional(),
    customer_id: uuid.optional(),
    cashier_user_id: uuid,
    /** The manager who approved it, where store policy requires one. */
    approved_by: uuid.optional(),
    receipt_no: z.string().min(1).max(64),
    reason_code: z.string().min(1).max(64),
    reason_note: z.string().max(512).optional(),
    subtotal_minor: moneyMinor,
    tax_minor: moneyMinor,
    total_minor: moneyMinor,
    restock: z.boolean().default(true),
    device_time: deviceTime,
    lines: z.array(refundLineInput).min(1).max(500),
    payments: z.array(paymentInput).default([]),
  })
  .superRefine((r, ctx) => {
    if (!r.original_sale_id) {
      // Not refused here: some stores permit it. The permission check and the
      // loss prevention report are where this is actually governed.
      if (!r.reason_note?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason_note'],
          message: 'a refund with no original sale must record an explanation',
        });
      }
    }
  });

// ----------------------------------------------------------------------- cash

export const cashMovementKind = z.enum([
  'opening_float',
  'sale',
  'refund',
  'paid_in',
  'paid_out',
  'drop',
  'pickup',
  'safe_deposit',
  'adjustment',
  'closing_count',
]);

export const openCashSessionSchema = z.object({
  register_id: uuid,
  opening_float_minor: moneyNonNegative,
  /**
   * A blind count hides the expected total from the person counting. It is the
   * only kind that measures anything: shown the expected number, people type it
   * back, and the count confirms itself rather than the drawer.
   */
  blind: z.boolean().default(true),
  note: z.string().max(512).optional(),
});

export const closeCashSessionSchema = z.object({
  counted_minor: moneyNonNegative,
  /** Per denomination counts, when the register collected them. */
  denominations: z.record(z.number().int().min(0)).optional(),
  note: z.string().max(512).optional(),
});

/**
 * Shared shape. Kept separate from the refined schemas below because
 * `.innerType()` returns the bare object and silently drops every refinement
 * attached to it - which is how a "paid out needs a reason" rule can pass
 * review, exist in the schema, and still never run.
 */
const cashMovementShape = z.object({
  id: uuidV7,
  session_id: uuid,
  kind: cashMovementKind,
  /** Signed. A paid_out is negative, a paid_in positive. */
  amount_minor: moneyMinor,
  reason: z.string().max(128).optional(),
  reference_type: z.string().max(32).optional(),
  reference_id: uuid.optional(),
  actor_user_id: uuid,
  approved_by: uuid.optional(),
  occurred_at: timestamp,
  note: z.string().max(512).optional(),
});

/**
 * Money leaving or entering a drawer outside a sale always needs a stated
 * reason. The database enforces this too (`cash_movement_reason`); without the
 * check here the violation surfaces as a constraint error rather than as a
 * field a cashier can fix.
 */
const requireReason = (m: { kind: string; reason?: string | undefined }, ctx: z.RefinementCtx) => {
  const needsReason: readonly string[] = ['paid_in', 'paid_out', 'adjustment'];
  if (needsReason.includes(m.kind) && !m.reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: `a ${m.kind} must record why money left or entered the drawer`,
    });
  }
};

export const cashMovementInput = cashMovementShape.superRefine(requireReason);

/** Manual drawer movements posted directly, rather than through a sync batch. */
export const postCashMovementSchema = cashMovementShape
  .omit({ id: true, actor_user_id: true, occurred_at: true })
  .extend({ occurred_at: timestamp.optional() })
  .superRefine(requireReason);

// ----------------------------------------------------------------- queries

export const saleQuerySchema = pagination.extend({
  store_id: uuid.optional(),
  register_id: uuid.optional(),
  cashier_user_id: uuid.optional(),
  customer_id: uuid.optional(),
  status: saleStatus.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export type SaleInput = z.infer<typeof saleInput>;
export type SaleLineInput = z.infer<typeof saleLineInput>;
export type PaymentInput = z.infer<typeof paymentInput>;
export type RefundInput = z.infer<typeof refundInput>;
export type CashMovementInput = z.infer<typeof cashMovementInput>;
export type AgeVerificationInput = z.infer<typeof ageVerificationInput>;
