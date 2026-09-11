/**
 * An upload that should be tried again rather than rejected.
 *
 * The sync route classifies failures as retryable or not, and gets it right for
 * database faults by inspecting Postgres error codes. Some intake failures are
 * transient for a reason the database cannot express: a void whose sale has not
 * arrived yet is the first of them.
 *
 * Entities are ordered inside a batch but not across batches, so a sale whose
 * upload failed while its void succeeded is a normal sequence, not a corrupt
 * one. Rejecting the void would dead letter it after five attempts — a sale
 * left standing that a manager already voided at the counter, and money the
 * day's numbers say was taken. Waiting is correct; the register keeps the void
 * in its outbox and delivers it again once the sale is there.
 */
export class RetryableIntakeError extends Error {
  override name = 'RetryableIntakeError';
}
