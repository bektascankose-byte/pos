import type { SegmentDefinition } from '@snappos/contracts';

/**
 * Compiling a saved segment into SQL.
 *
 * The definition is data a user composed in a form, so every value here
 * becomes a bound parameter and nothing is ever interpolated into the string.
 * That is the whole reason segments are stored as structured jsonb rather
 * than as SQL: storing SQL a user can edit is storing an injection with extra
 * steps.
 *
 * Clauses combine with AND. An empty definition compiles to no clauses at
 * all, which is "every active customer" -- a legitimate thing to want, and
 * why it isn't treated as an error.
 */
export function buildSegmentQuery(
  definition: SegmentDefinition,
  /**
   * The first placeholder number this fragment may use. Callers bind the
   * channel ahead of the segment's own values, so the numbering has to start
   * where theirs left off -- getting this wrong silently reads one parameter
   * as another, which is the kind of bug that produces a plausible wrong
   * recipient list rather than an error.
   */
  startIndex = 1,
): { where: string; params: unknown[] } {
  const clauses: string[] = [
    // Archived customers are not marketed to, and an anonymized one has had
    // their identity deliberately erased -- mailing that row would undo it.
    `c.status = 'active'`,
    `c.anonymized_at IS NULL`,
  ];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${startIndex + params.length - 1}`;
  };

  // The "bought" filters share one EXISTS so that `within_days` applies to
  // whichever of them is set, rather than each growing its own copy of the
  // window logic.
  if (definition.bought_product_id || definition.bought_category_id) {
    const conditions: string[] = [];
    if (definition.bought_product_id) conditions.push(`pv.product_id = ${bind(definition.bought_product_id)}`);
    if (definition.bought_category_id) conditions.push(`p.category_id = ${bind(definition.bought_category_id)}`);
    const window = definition.within_days
      ? `AND s.completed_at >= now() - make_interval(days => ${bind(definition.within_days)})`
      : '';

    clauses.push(`EXISTS (
      SELECT 1 FROM sales s
      JOIN sale_lines sl ON sl.sale_id = s.id
      JOIN product_variants pv ON pv.id = sl.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE s.customer_id = c.id
        AND s.status = 'completed'
        -- A line returned in full was not a purchase for this purpose: the
        -- point of "bought X" is to reach people who want more of it.
        AND sl.quantity > sl.quantity_refunded
        AND ${conditions.join(' AND ')}
        ${window}
    )`);
  }

  // "Not seen in N days" has to include customers who have never bought at
  // all -- NOT EXISTS rather than a comparison against their last visit,
  // which would silently drop everyone with no sales.
  if (definition.not_seen_days) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM sales s
      WHERE s.customer_id = c.id
        AND s.status = 'completed'
        AND s.completed_at >= now() - make_interval(days => ${bind(definition.not_seen_days)})
    )`);
  }

  if (definition.min_visits) {
    clauses.push(`(
      SELECT count(*) FROM sales s
      WHERE s.customer_id = c.id AND s.status = 'completed'
    ) >= ${bind(definition.min_visits)}`);
  }

  // Net of refunds, matching what the customer page shows as lifetime spend.
  // A segment whose threshold meant something different from the number on
  // the record it filters would be worse than no segment.
  if (definition.min_lifetime_spend_minor !== undefined) {
    clauses.push(`(
      (SELECT COALESCE(sum(s.total_minor), 0) FROM sales s
        WHERE s.customer_id = c.id AND s.status = 'completed')
      - (SELECT COALESCE(sum(r.total_minor), 0) FROM refunds r
          WHERE r.customer_id = c.id
             OR r.original_sale_id IN (SELECT id FROM sales WHERE customer_id = c.id))
    ) >= ${bind(definition.min_lifetime_spend_minor.toString())}`);
  }

  if (definition.has_tag) {
    clauses.push(`${bind(definition.has_tag)} = ANY(c.tags)`);
  }

  return { where: clauses.join('\n AND '), params };
}

/**
 * Whether a customer has a live opt-in on a channel.
 *
 * The consent table is an append-only log, so "currently granted" is the most
 * recent event saying so -- not merely the existence of a grant somewhere in
 * the history, which would keep mailing someone who unsubscribed last week.
 * A customer with no row at all fails this, which is the rule the table was
 * written for: silence is not consent.
 *
 * `channelParam` is the caller's placeholder for the channel (e.g. `'$1'`),
 * so this composes with `buildSegmentQuery`'s own numbering.
 */
export function consentGrantedSql(channelParam: string): string {
  return `EXISTS (
    SELECT 1 FROM customer_consents cc
    WHERE cc.customer_id = c.id AND cc.channel = ${channelParam}
      AND cc.granted
      AND cc.occurred_at = (
        SELECT max(occurred_at) FROM customer_consents
        WHERE customer_id = c.id AND channel = ${channelParam}
      )
  )`;
}

/**
 * Whether the address itself must never be mailed -- unsubscribed, hard
 * bounced, or reported as spam.
 *
 * Checked by address rather than by customer, and separately from consent,
 * because they are different facts: consent is what a person wants, and a
 * suppression is the address being unusable. The same address can appear on
 * two customer records, and a bounce applies to both.
 *
 * `addressColumn` is a column expression (`c.email`), not a bound value.
 */
export function suppressedSql(channelParam: string, addressColumn: string): string {
  return `EXISTS (
    SELECT 1 FROM message_suppressions ms
    WHERE ms.channel = ${channelParam} AND lower(ms.address) = lower(${addressColumn})
  )`;
}
