import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MessagingService, type OutboundMessage } from './messaging.service.js';
import { ApiException } from '../errors/api-exception.js';

/**
 * Emails a customer is waiting for: confirm your address, reset your password,
 * your order is ready.
 *
 * Sent through `MessagingService` when a provider is configured. When one is
 * not, a development server writes each message to a file instead -- the
 * development mailbox -- so every flow that depends on an email can be worked
 * through on a laptop. A production server with no provider refuses, loudly:
 * a customer told "check your email" for a message that went nowhere is worse
 * than an error.
 *
 * The mailbox holds live links, which is why it exists only outside
 * production, lives in a git-ignored folder, and is never logged.
 */
@Injectable()
export class TransactionalMailer {
  private readonly logger = new Logger(TransactionalMailer.name);

  constructor(private readonly messaging: MessagingService) {}

  /** Whether a real message would leave this server. */
  sendsRealEmail(): boolean {
    return this.messaging.emailConfigured();
  }

  async send(kind: string, message: OutboundMessage): Promise<'provider' | 'dev_mailbox'> {
    if (this.messaging.emailConfigured()) {
      const outcome = await this.messaging.sendEmail(message);
      if (!outcome.ok) {
        // The provider's own error can quote the address it rejected, so it is
        // not repeated here; the kind of message is enough to find the cause.
        throw new ApiException('provider_unavailable', `the ${kind} email was not accepted by the provider`, {
          retryable: true,
        });
      }
      return 'provider';
    }

    if (process.env.NODE_ENV === 'production') {
      throw new ApiException('provider_unavailable', 'email sending is not configured on this server', {
        retryable: false,
      });
    }

    const folder = process.env.DEV_MAILBOX_DIR || join(process.cwd(), '.dev-mailbox');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(folder, `${stamp}-${kind}-${randomBytes(3).toString('hex')}.eml`);
    await writeFile(
      file,
      [
        `To: ${message.to}`,
        `Subject: ${message.subject ?? ''}`,
        `Date: ${new Date().toUTCString()}`,
        'X-SnapPOS-Dev-Mailbox: not sent',
        '',
        message.body,
        '',
      ].join('\n'),
      'utf8',
    );
    this.logger.log(`${kind} email written to the development mailbox`);
    return 'dev_mailbox';
  }
}
