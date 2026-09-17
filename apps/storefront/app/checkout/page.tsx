import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckoutForm } from "@/components/CheckoutForm";
import { money } from "@/lib/format";
import { getCart, getCustomer, getShopInfo } from "@/lib/shop";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const [cart, customer, info] = await Promise.all([getCart(), getCustomer(), getShopInfo()]);
  if (!cart || cart.lines.length === 0) redirect("/cart");
  if (!cart.can_checkout) redirect("/cart");

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="display text-4xl font-extrabold uppercase">Checkout</h1>
          <p className="text-[var(--muted)]">
            Pickup at {info?.store.name ?? "the shop"}. You pay when you collect.
          </p>
        </div>
        {!customer ? (
          <p className="text-sm">
            Have an account?{" "}
            <Link href="/account/sign-in?next=/checkout" className="font-semibold underline underline-offset-2">
              Sign in
            </Link>{" "}
            to check out faster, or carry on as a guest.
          </p>
        ) : null}
        <CheckoutForm customer={customer} totalLabel={money(cart.estimated_total_minor)} minimumAge={cart.minimum_age} />
      </div>

      <aside aria-labelledby="order-summary" className="flex h-fit flex-col gap-4 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
        <h2 id="order-summary" className="display text-2xl font-bold uppercase">
          Your order
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {cart.lines.map((line) => (
            <li key={line.variant_id} className="flex justify-between gap-3">
              <span>
                <span className="tabular">{line.quantity} ×</span> {line.product_name}
                {line.variant_name ? `, ${line.variant_name}` : ""}
              </span>
              <span className="tabular">{line.line_total_minor ? money(line.line_total_minor) : ""}</span>
            </li>
          ))}
        </ul>
        <dl className="tabular flex flex-col gap-1.5 border-t border-[var(--line)] pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Subtotal</dt>
            <dd>{money(cart.subtotal_minor)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Estimated sales tax</dt>
            <dd>{money(cart.estimated_tax_minor)}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <dt>Total at pickup</dt>
            <dd>{money(cart.estimated_total_minor)}</dd>
          </div>
        </dl>
        <Link href="/cart" className="text-sm underline underline-offset-2">
          Change your cart
        </Link>
      </aside>
    </div>
  );
}
