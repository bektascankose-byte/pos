import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email the shop sends because something happened, not because it is selling
 * anything: a password reset, and whatever follows it.
 *
 * Deliberately not `MessagingService`. That one is the marketing path -- it
 * goes out over SendGrid from the marketing address, it is gated on a
 * marketing provider being configured, and a campaign that cannot send is a
 * campaign postponed. A password reset is none of those things: it must leave
 * from an address the shop owns, it must not be suppressed by somebody
 * unsubscribing from promotions, and it failing is a person locked out.
 * Keeping them apart means neither can quietly break the other.
 *
 * Plain SMTP, because that is what a mailbox at an ordinary host gives you and
 * it needs no account with anybody else.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transport: Transporter | undefined;

  isConfigured(): boolean {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  }

  /** The address these come from, for anything that needs to name it. */
  from(): string {
    return process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost';
  }

  /**
   * Send, and say whether it went.
   *
   * Never throws. Every caller so far is a flow whose answer to the person
   * must not depend on what the mail server said -- the reset endpoint
   * answers the same way whether or not an account exists, and an exception
   * here would leak exactly that through a 500. The failure goes to the log,
   * which is where somebody looking into "I never got the email" will start.
   */
  async send(message: TransactionalEmail): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) {
      this.logger.error(
        `cannot send "${message.subject}": SMTP is not configured -- set SMTP_HOST, SMTP_USER and SMTP_PASSWORD`,
      );
      return { ok: false, error: 'smtp_not_configured' };
    }

    try {
      const transport = this.getTransport();
      await transport.sendMail({
        from: this.from(),
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      // The address is logged because the whole point of this log line is
      // answering "did my reset email go"; the body never is, since it
      // carries the one time token.
      this.logger.error(`could not email ${message.to}: ${detail}`);
      return { ok: false, error: detail };
    }
  }

  /**
   * Built once and reused, so a burst of mail opens one connection rather than
   * one each. Port 465 is implicit TLS; anything else (587 in practice) starts
   * plaintext and upgrades, which `secure: false` means here rather than "no
   * encryption" -- `requireTLS` makes the upgrade mandatory, so a server that
   * will not do STARTTLS fails instead of sending a password in the clear.
   */
  private getTransport(): Transporter {
    if (this.transport) return this.transport;

    const port = Number(process.env.SMTP_PORT ?? 587);
    this.transport = createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    return this.transport;
  }
}
