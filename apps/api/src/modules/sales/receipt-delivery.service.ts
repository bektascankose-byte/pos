import { Injectable, Logger } from '@nestjs/common';
import { normalizeUsPhone } from '@snappos/contracts';
import type { SendReceiptInput, SendReceiptResult } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { MailerService } from '../../platform/mail/mailer.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

/**
 * Sending a customer their receipt, by something other than paper.
 *
 * Every attempt is written to `receipt_deliveries` whether or not it left the
 * building, because "I never got it" is a question somebody will ask at the
 * counter and the answer has to come from somewhere other than memory.
 *
 * Two channels, at two different stages of existing, and the difference is
 * deliberately visible rather than smoothed over:
 *
 *   email  goes now, over the shop's own mailbox.
 *   sms    has no provider yet. The request is kept, marked queued, and the
 *          cashier is told plainly that it has not gone. A button that says
 *          "Sent" when nothing was sent is worse than no button, because the
 *          cashier repeats the lie to the customer.
 */
@Injectable()
export class ReceiptDeliveryService {
  private readonly logger = new Logger(ReceiptDeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailer: MailerService,
  ) {}

  async send(
    orgId: string,
    saleId: string,
    actorUserId: string,
    input: SendReceiptInput,
  ): Promise<SendReceiptResult> {
    const sale = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ receipt_no: string; store_name: string }>(
        `SELECT s.receipt_no, st.name AS store_name
         FROM sales s JOIN stores st ON st.id = s.store_id
         WHERE s.id = $1`,
        [saleId],
      );
      return rows[0];
    });

    // The register rings sales offline and uploads them afterwards, so a sale
    // can be real and on paper while this server has still never heard of it.
    // Saying so is better than either inventing a row or sending a receipt
    // nothing can be matched against later.
    if (!sale) {
      throw new ApiException(
        'conflict',
        `sale ${saleId} has not reached the back office yet`,
        {
          userMessage:
            'This sale has not reached the back office yet. Try again in a moment.',
          // It will arrive: the register is holding it in its outbox. Saying
          // so keeps anything retrying from giving up on it.
          retryable: true,
        },
      );
    }

    const destination =
      input.channel === 'sms'
        ? (normalizeUsPhone(input.destination) ?? input.destination.trim())
        : input.destination.trim().toLowerCase();

    if (input.channel === 'sms') {
      await this.record(orgId, saleId, actorUserId, 'sms', destination, 'queued', null, null);
      return {
        status: 'queued',
        note: 'Texting is not switched on yet. This one is saved and will go out once it is.',
      };
    }

    if (!this.mailer.isConfigured()) {
      await this.record(orgId, saleId, actorUserId, 'email', destination, 'queued', null, null);
      return {
        status: 'queued',
        note: 'Email is not switched on yet. This one is saved and will go out once it is.',
      };
    }

    const sent = await this.mailer.send({
      to: destination,
      subject: `Your receipt from ${sale.store_name} (${sale.receipt_no})`,
      text: input.body,
    });

    if (!sent.ok) {
      await this.record(
        orgId, saleId, actorUserId, 'email', destination, 'failed',
        sent.error ?? 'the mail server refused it', null,
      );
      this.logger.error(
        `receipt ${sale.receipt_no} could not be emailed to ${destination}: ${sent.error}`,
      );
      return { status: 'failed', note: 'The email did not go. Print it instead.' };
    }

    await this.record(
      orgId, saleId, actorUserId, 'email', destination, 'sent', null, new Date(),
    );
    return { status: 'sent', note: `Emailed to ${destination}.` };
  }

  /** Every attempt, including the ones that did not go. */
  private async record(
    orgId: string,
    saleId: string,
    actorUserId: string,
    channel: 'email' | 'sms',
    destination: string,
    status: 'sent' | 'queued' | 'failed',
    error: string | null,
    deliveredAt: Date | null,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO receipt_deliveries
           (org_id, sale_id, channel, destination, status, error, delivered_at)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)`,
        [saleId, channel, destination, status, error, deliveredAt],
      );
    });
    this.logger.log(
      `receipt for sale ${saleId}: ${channel} to ${destination} -> ${status}` +
        ` (requested by ${actorUserId})`,
    );
  }

  /** Where this sale's receipt has been sent, newest first. */
  async history(orgId: string, saleId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, channel, destination, status, error, requested_at, delivered_at
         FROM receipt_deliveries
         WHERE sale_id = $1
         ORDER BY requested_at DESC`,
        [saleId],
      );
      return rows;
    });
  }
}
