import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ShopCustomerOrder } from "@snappos/contracts";
import { ChangePasswordForm, MarketingForm, ProfileForm } from "@/components/AccountForms";
import { shopFetch } from "@/lib/api";
import { dateTime, money } from "@/lib/format";
import { getCustomer, getShopInfo } from "@/lib/shop";
import { signOutAction } from "./actions";

export const metadata: Metadata = { title: "Your account", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string; reset?: string }>;
}) {
  const [customer, info] = await Promise.all([getCustomer(), getShopInfo()]);
  if (!customer) redirect("/account/sign-in?next=/account");
  const { welcome, reset } = await searchParams;
  const orders = await shopFetch<ShopCustomerOrder[]>("/account/me/orders", { withCart: false }).catch(() => []);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {welcome ? <p role="status" className="text-sm text-[var(--ok)]">Your email is confirmed. You&apos;re signed in.</p> : null}
          {reset ? <p role="status" className="text-sm text-[var(--ok)]">Your password is changed. You&apos;re signed in.</p> : null}
          <h1 className="display text-4xl font-extrabold uppercase">
            {customer.first_name ? `Hi, ${customer.first_name}` : "Your account"}
          </h1>
        </div>
        <form action={signOutAction}>
          <button type="submit" className="btn btn-quiet text-sm">
            Sign out
          </button>
        </form>
      </div>

      <section aria-labelledby="orders-heading" className="flex flex-col gap-3">
        <h2 id="orders-heading" className="display text-2xl font-bold uppercase">
          Your orders
        </h2>
        {orders.length === 0 ? (
          <p className="text-[var(--muted)]">
            No orders yet.{" "}
            <Link href="/" className="underline underline-offset-2">
              Start shopping
            </Link>
            .
          </p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
            <table className="w-full text-sm">
              <caption className="sr-only">Your orders, newest first</caption>
              <thead className="text-left text-[var(--muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-normal">Order</th>
                  <th scope="col" className="px-4 py-3 font-normal">Placed</th>
                  <th scope="col" className="px-4 py-3 font-normal">Status</th>
                  <th scope="col" className="px-4 py-3 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.order_number} className="border-t border-[var(--line)]">
                    <td className="px-4 py-3">
                      <Link href={`/track/${order.tracking_token}`} className="font-semibold underline underline-offset-2">
                        {order.order_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{dateTime(order.placed_at, info?.store.timezone)}</td>
                    <td className="px-4 py-3">{order.status_label}</td>
                    <td className="tabular px-4 py-3 text-right">{money(order.total_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="details-heading" className="flex flex-col gap-3 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
          <h2 id="details-heading" className="display text-2xl font-bold uppercase">
            Your details
          </h2>
          <ProfileForm customer={customer} />
        </section>

        <div className="flex flex-col gap-6">
          <section aria-labelledby="email-heading" className="flex flex-col gap-3 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
            <h2 id="email-heading" className="display text-2xl font-bold uppercase">
              Emails from us
            </h2>
            <p className="text-sm text-[var(--muted)]">
              Order updates are always sent. Offers are sent only if you ask for them here.
            </p>
            <MarketingForm customer={customer} />
          </section>

          <section aria-labelledby="password-heading" className="flex flex-col gap-3 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
            <h2 id="password-heading" className="display text-2xl font-bold uppercase">
              Password
            </h2>
            <ChangePasswordForm />
          </section>
        </div>
      </div>
    </div>
  );
}
