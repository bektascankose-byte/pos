import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../errors/api-exception.js';

export interface OutboundMessage {
  to: string;
  subject?: string | undefined;
  /** Plain text. Every message this system sends is text; HTML email is a later decision, not an oversight. */
  body: string;
  /** Appended by the caller for promotional email, not invented here -- see `CampaignsService`. */
  headers?: Record<string, string> | undefined;
}

export interface SendOutcome {
  ok: boolean;
  provider_message_id?: string | undefined;
  error?: string | undefined;
}

/**
 * Sending email and text messages.
 *
 * Deliberately lazy, following `AiService` rather than `ObjectStorageService`:
 * a shop that has not bought a provider yet still boots, and
 * `provider_unavailable` is raised at the moment someone actually tries to
 * send rather than at startup. A back office that refuses to start because
 * nobody has configured SendGrid would be a worse failure than a campaign
 * screen that says so.
 *
 * ## Why email and SMS are not symmetrical
 *
 * US carriers filter A2P (application-to-person) text messaging for SHAFT
 * content -- Sex, Hate, Alcohol, Firearms, Tobacco -- and vape is tobacco for
 * this purpose. Twilio returns error 30458 ("Disallowed: SHAFT - Tobacco /
 * Vape") for exactly this, and cannabis/CBD is barred outright as federally
 * illegal. That filtering is applied by the carrier, downstream of consent:
 * a customer who explicitly opted in still does not receive the message, and
 * the shop's number accumulates violations.
 *
 * So `sendSms` exists and is wired for transactional messages -- a receipt, an
 * order-ready notice -- and `CampaignsService` refuses to send a *promotional*
 * SMS campaign. Email carries promotions, because SendGrid's own policy
 * permits tobacco with age verification and affirmative consent.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  emailConfigured(): boolean {
    return Boolean(process.env.SENDGRID_API_KEY && process.env.MARKETING_FROM_EMAIL);
  }

  smsConfigured(): boolean {
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER,
    );
  }

  /**
   * One promotional or transactional email.
   *
   * A failure comes back as `{ ok: false, error }` rather than throwing,
   * because a campaign of four hundred must not stop at the first bad
   * address -- that recipient is recorded as failed and the rest go out. A
   * *missing configuration* is different and does throw: that is not this
   * message's problem, it is the server's, and reporting four hundred
   * identical per-recipient failures would bury it.
   */
  async sendEmail(message: OutboundMessage): Promise<SendOutcome> {
    const apiKey = process.env.SENDGRID_API_KEY;
    const from = process.env.MARKETING_FROM_EMAIL;
    if (!apiKey || !from) {
      throw new ApiException(
        'provider_unavailable',
        'email sending is not configured on this server -- set SENDGRID_API_KEY and MARKETING_FROM_EMAIL',
        { retryable: false },
      );
    }

    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [{ email: message.to }],
              ...(message.headers ? { headers: message.headers } : {}),
            },
          ],
          from: { email: from, ...(process.env.MARKETING_FROM_NAME ? { name: process.env.MARKETING_FROM_NAME } : {}) },
          subject: message.subject ?? '',
          content: [{ type: 'text/plain', value: message.body }],
        }),
      });

      if (!response.ok) {
        // SendGrid puts the useful part in an `errors` array; the status alone
        // ("400") tells a shop owner nothing about which address was wrong.
        const payload = (await response.json().catch(() => null)) as
          | { errors?: { message?: string }[] }
          | null;
        const detail = payload?.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ');
        return { ok: false, error: detail || `sendgrid returned ${response.status}` };
      }

      // 202 Accepted with an empty body is the success case; the id is in a header.
      return { ok: true, provider_message_id: response.headers.get('x-message-id') ?? undefined };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'could not reach the email provider' };
    }
  }

  /**
   * One transactional text message -- a receipt, an order-ready notice.
   *
   * Not for promotions: see the class comment. `CampaignsService` enforces
   * that; this method does not, because a transactional send is legitimate
   * and this is the method that performs it.
   */
  async sendSms(message: { to: string; body: string }): Promise<SendOutcome> {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) {
      throw new ApiException(
        'provider_unavailable',
        'text messaging is not configured on this server -- set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER',
        { retryable: false },
      );
    }

    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: message.to, From: from, Body: message.body }).toString(),
      });

      const payload = (await response.json().catch(() => null)) as
        | { sid?: string; message?: string; code?: number }
        | null;

      if (!response.ok) {
        // 30458 is "Disallowed: SHAFT - Tobacco / Vape". Worth naming, because
        // the generic message reads like a transient fault and this is not
        // one -- it will fail identically forever until the shop registers
        // through a specialist.
        const detail =
          payload?.code === 30458
            ? 'carriers blocked this as tobacco/vape content (Twilio 30458) — SMS cannot carry vape promotions on a standard A2P registration'
            : (payload?.message ?? `twilio returned ${response.status}`);
        return { ok: false, error: detail };
      }

      return { ok: true, provider_message_id: payload?.sid };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'could not reach the SMS provider' };
    }
  }
}
