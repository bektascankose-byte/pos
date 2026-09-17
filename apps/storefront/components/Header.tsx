import Link from "next/link";
import type { ShopInfo } from "@snappos/contracts";
import { getCart, getCategories, getCustomer } from "@/lib/shop";
import { SearchBox } from "./SearchBox";

export async function Header({ info }: { info: ShopInfo | null }) {
  const [cart, categories, customer] = await Promise.all([
    getCart().catch(() => null),
    getCategories(),
    getCustomer().catch(() => null),
  ]);
  const count = cart?.item_count ?? 0;
  const topLevel = categories.filter((category) => category.depth === 0);

  return (
    <header className="border-b border-[var(--line)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3 sm:gap-x-6 sm:px-6">
        <Link href="/" className="flex flex-col leading-none" aria-label={`${info?.shop_name ?? "Shop"}, home`}>
          <span className="display text-2xl font-extrabold uppercase sm:text-3xl">{info?.shop_name ?? "Shop"}</span>
          {info?.store.city ? (
            <span className="eyebrow mt-1">Pickup in {info.store.city}</span>
          ) : null}
        </Link>

        {/* Its own row until there is room beside the name and buttons: squeezed in
            between them on a tablet, the box left about ten pixels to type in. */}
        <div className="order-3 w-full lg:order-none lg:w-auto lg:flex-1">
          <SearchBox />
        </div>

        {/* On a phone both buttons are icons, so they fit on the row with the shop's
            name; their words stay for screen readers and come back from sm up. */}
        <nav aria-label="Your account and cart" className="ml-auto flex items-center gap-2">
          <Link
            href={customer ? "/account" : "/account/sign-in"}
            className="btn btn-quiet w-11 px-0 text-sm sm:w-auto sm:px-4"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
            </svg>
            <span className="sr-only sm:not-sr-only">
              {customer ? (customer.first_name ? `Hi, ${customer.first_name}` : "Account") : "Sign in"}
            </span>
          </Link>
          <Link href="/cart" className="btn btn-primary px-3 text-sm sm:px-4">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8h14l-1 13H6L5 8Z" />
              <path d="M9 8V6a3 3 0 0 1 6 0v2" />
            </svg>
            <span className="sr-only sm:not-sr-only">Cart</span>
            <span className="tabular rounded-full bg-[var(--ember-ink)] px-2 text-xs leading-5 text-[var(--ember)]">
              {count}
            </span>
            <span className="sr-only">{count === 1 ? "item" : "items"}</span>
          </Link>
        </nav>
      </div>

      {topLevel.length > 0 ? (
        <nav aria-label="Categories" className="border-t border-[var(--line)]">
          <ul className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 py-1.5 sm:px-6">
            {topLevel.map((category) => (
              <li key={category.id} className="shrink-0">
                <Link
                  href={`/c/${category.slug}`}
                  className="inline-flex min-h-[40px] items-center rounded-full px-3 text-sm font-medium hover:bg-[var(--surface-sunk)]"
                >
                  {category.name}
                </Link>
              </li>
            ))}
            <li className="shrink-0">
              <Link
                href="/store"
                className="inline-flex min-h-[40px] items-center rounded-full px-3 text-sm text-[var(--muted)] hover:bg-[var(--surface-sunk)]"
              >
                Store &amp; pickup
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
