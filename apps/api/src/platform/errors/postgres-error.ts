import { ApiException } from './api-exception.js';

/**
 * Map a Postgres error to the API's own error type.
 *
 * A constraint violation is a statement about the request, not about the
 * server: asking to refund four of something that was sold in a quantity of
 * three is a client error, and returning 500 for it tells the caller to retry
 * something that will never succeed. The register reads `retryable` to decide
 * between backing off and dead lettering, so getting this wrong either loses a
 * sale or retries forever.
 *
 * What is emphatically NOT done here is passing the database message through.
 * A Postgres error can name the constraint, the columns, and the value that
 * violated it — and on this schema that value may be a customer's phone number.
 * The mapping produces a stable code and a message written for this API, and
 * the original goes to the log.
 */
export function mapPostgresError(error: unknown): ApiException | null {
  const code = (error as { code?: string }).code;
  if (typeof code !== 'string') return null;

  const constraint = (error as { constraint?: string }).constraint;

  switch (code) {
    // unique_violation. Almost always a duplicate submission that reached a
    // path without ON CONFLICT handling.
    case '23505':
      return new ApiException('conflict', describeUnique(constraint), { retryable: false });

    // foreign_key_violation. Referencing something that does not exist, or is
    // in another organization, which RLS has already made invisible.
    case '23503':
      return new ApiException(
        'validation_failed',
        'the request references something that does not exist',
        { retryable: false },
      );

    // check_violation. A business rule the schema enforces directly.
    case '23514':
      return new ApiException('validation_failed', describeCheck(constraint), {
        retryable: false,
      });

    // not_null_violation
    case '23502':
      return new ApiException('validation_failed', 'a required field was missing', {
        retryable: false,
      });

    // raise_exception, used by the append only guards.
    case 'P0001':
      return new ApiException('conflict', 'that record cannot be changed once written', {
        userMessage: 'This record is final. Create a correction instead.',
        retryable: false,
      });

    // Transient. Worth retrying exactly as sent.
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new ApiException('conflict', 'the request conflicted with another; retry', {
        retryable: true,
      });
    case '53300': // too_many_connections
    case '57P01': // admin_shutdown
    case '08006': // connection_failure
    case '08003':
      return new ApiException('provider_unavailable', 'the database is unavailable', {
        retryable: true,
      });

    default:
      return null;
  }
}

/** Constraint names the API can explain better than Postgres can. */
function describeCheck(constraint?: string): string {
  switch (constraint) {
    case 'cash_movement_reason':
      return 'this kind of drawer movement must record a reason';
    case 'ledger_delta_nonzero':
      return 'a stock movement of zero records nothing';
    case 'sale_line_refund_bound':
      return 'that would refund more units than were sold';
    case 'payment_last4_fmt':
      return 'card_last4 must be exactly four digits';
    case 'payment_target':
      return 'a payment must belong to exactly one of a sale or a refund';
    case 'sales_completed_fields':
      return 'a completed sale must carry the time it completed';
    case 'sales_tax_exempt_reason':
      return 'a tax exempt sale must record why';
    case 'customers_contactable':
      return 'a customer needs a phone or an email';
    case 'users_contactable':
      return 'an employee needs a phone or an email';
    default:
      return 'the request violates a rule the database enforces';
  }
}

function describeUnique(constraint?: string): string {
  switch (constraint) {
    case 'sales_receipt_key':
      return 'a sale with that receipt number already exists';
    case 'sales_register_seq_key':
      return 'that register has already used that sequence number';
    case 'refunds_receipt_key':
      return 'a refund with that receipt number already exists';
    case 'cash_sessions_open_key':
      return 'that register already has an open cash session';
    case 'customers_org_phone_key':
      return 'a customer with that phone number already exists';
    case 'customers_org_email_key':
      return 'a customer with that email already exists';
    case 'users_org_email_key':
      return 'an employee with that email already exists';
    case 'users_org_code_key':
      return 'an employee with that employee code already exists';
    default:
      return 'that record already exists';
  }
}
