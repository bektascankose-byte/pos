import { UnsubscribeClient } from "./UnsubscribeClient";

/**
 * The page an unsubscribe link lands on.
 *
 * Deliberately outside the `(app)` group, so it has no sidebar, no session and
 * no `middleware` redirect to a login screen: the person here is a customer
 * reading their email, not a user of the back office. CAN-SPAM requires the
 * opt-out to work without making them sign in or explain themselves.
 *
 * It does not unsubscribe on load. A mail client that pre-fetches links would
 * otherwise opt people out who never clicked anything — a well-known way to
 * silently destroy a mailing list. One button, one deliberate press.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <UnsubscribeClient token={token} />;
}
