import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MessagingService } from './messaging.service.js';
import { ApiException } from '../errors/api-exception.js';

/**
 * Text messages a customer is waiting for: a code to prove their phone.
 *
 * The text-message twin of `TransactionalMailer`. Twilio when it is configured;
 * otherwise, outside production, the message is written to the development
 * mailbox as a `.txt` file, so the code can be read and the flow worked
 * through on a laptop. A production server with no provider refuses rather
 * than telling a customer to wait for a text that is not coming.
 *
 * Nothing here is promotional, and nothing may be: carriers block tobacco and
 * vape promotions on ordinary text messaging. A verification code is
 * transactional, and says nothing about products.
 */
@Injectable()
export class TransactionalTexter {
  private readonly logger = new Logger(TransactionalTexter.name);

  constructor(private readonly messaging: MessagingService) {}

  async send(kind: string, message: { to: string; body: string }): Promise<'provider' | 'dev_mailbox'> {
    if (this.messaging.smsConfigured()) {
      const outcome = await this.messaging.sendSms(message);
      if (!outcome.ok) {
        throw new ApiException('provider_unavailable', `the ${kind} text was not accepted by the provider`, {
          retryable: true,
        });
      }
      return 'provider';
    }

    if (process.env.NODE_ENV === 'production') {
      throw new ApiException('provider_unavailable', 'text messaging is not configured on this server', {
        retryable: false,
      });
    }

    const folder = process.env.DEV_MAILBOX_DIR || join(process.cwd(), '.dev-mailbox');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(
      join(folder, `${stamp}-${kind}-${randomBytes(3).toString('hex')}.txt`),
      [`To: ${message.to}`, `Date: ${new Date().toUTCString()}`, 'X-SnapPOS-Dev-Mailbox: text not sent', '', message.body, ''].join('\n'),
      'utf8',
    );
    this.logger.log(`${kind} text written to the development mailbox`);
    return 'dev_mailbox';
  }
}
