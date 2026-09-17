import type { Metadata } from "next";
import Link from "next/link";
import { CartLine } from "@/components/CartLine";
import { AgeBadge } from "@/components/ProductCard";
import { money } from "@/lib/format";
import { getCart } from "@/lib/shop";

export const metadata: Metadata = { title: "Cart", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const cart = await getCart();

  if (!cart || cart.lines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="display text-4xl font-extrabold uppercase">Your cart</h1>
        <p className="text-[var(--muted)]">Your cart is empty.</p>
        <Link href="/" className="btn btn-primary">
          Start shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <section aria-labelledby="cart-heading">
        <h1 id="cart-heading" className="display text-4xl font-extrabold uppercase">
          Your cart
        </h1>
        <ul className="mt-2 divide-y divide-[var(--line)]">
          {cart.lines.map((line) => (
            <CartLine key={line.variant_id} line={line} />
          ))}
        </ul>
      </section>

      <aside aria-labelledby="summary-heading" className="flex h-fit flex-col gap-4 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
        <h2 id="summary-heading" className="display text-2xl font-bold uppercase">
          Summary
        </h2>
        <dl className="tabular flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Subtotal</dt>
            <dd>{money(cart.subtotal_minor)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Estimated sales tax</dt>
            <dd>{money(cart.estimated_tax_minor)}</dd>
          </div>
          <div className="flex justify-between border-t border-[var(--line)] pt-2 text-base font-semibold">
            <dt>Total at pickup</dt>
            <dd>{money(cart.estimated_total_minor)}</dd>
          </div>
        </dl>

        <p className="text-sm text-[var(--muted)]">You pay in store when you collect. Nothing is charged online.</p>

        {cart.minimum_age ? (
          <p className="flex items-start gap-2 text-sm">
            <AgeBadge age={cart.minimum_age} />
            <span>Bring a photo ID. We check it when you pick up.</span>
          </p>
        ) : null}

        {cart.can_checkout ? (
          <Link href="/checkout" className="btn btn-primary w-full">
            Check out
          </Link>
        ) : (
          <>
            <button type="button" className="btn btn-primary w-full" disabled aria-describedby="cart-blocked">
              Check out
            </button>
            <p id="cart-blocked" className="text-sm text-[var(--danger)]">
              Fix the items marked above to continue.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
