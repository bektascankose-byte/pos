import Link from "next/link";

/** A tracking link that doesn't check out -- most often one cut short by an email app. */
export default function OrderNotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 py-10">
      <h1 className="display text-5xl font-extrabold uppercase">Can&apos;t find that order</h1>
      <p className="text-[var(--muted)]">
        The link may be incomplete. Open it again from your order confirmation email, or contact the shop with your
        order number.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/store" className="btn btn-primary">
          Contact the shop
        </Link>
        <Link href="/" className="btn btn-quiet">
          Back to the shop
        </Link>
      </div>
    </div>
  );
}
