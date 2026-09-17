import Link from "next/link";
import type { ShopProductList } from "@snappos/contracts";
import { ProductGrid } from "@/components/ProductCard";
import { FeatureBanners, HeroBanner } from "@/components/Banner";
import { shopFetch } from "@/lib/api";
import { getBanners, getCategories, getShopInfo } from "@/lib/shop";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [info, categories, featured, heroes, features] = await Promise.all([
    getShopInfo(),
    getCategories(),
    shopFetch<ShopProductList>("/products?in_stock=true&page_size=8", { withCart: false, withSession: false }).catch(
      () => null,
    ),
    getBanners("home_hero"),
    getBanners("home_feature"),
  ]);
  const hero = heroes[0] ?? null;
  const topLevel = categories.filter((category) => category.depth === 0);

  return (
    <div className="flex flex-col gap-10">
      {hero ? (
        <HeroBanner banner={hero} />
      ) : (
      <section className="flex flex-col gap-4 rounded-3xl bg-[var(--ink)] px-6 py-8 text-[var(--bg)] sm:px-10 sm:py-10">
        <p className="eyebrow text-[color-mix(in_srgb,var(--bg)_70%,transparent)]">Order online · pick up in store</p>
        <h1 className="display max-w-3xl text-4xl font-extrabold uppercase sm:text-6xl">
          Order ahead. Collect at {info?.store.name ?? "the shop"}.
        </h1>
        <p className="max-w-xl text-[color-mix(in_srgb,var(--bg)_80%,transparent)]">
          Choose what you want, and we&apos;ll have it ready at the counter. Pay when you pick up. Bring a photo ID — you
          must be 21 or older.
        </p>
      </section>
      )}

      {features.length > 0 ? (
        <section aria-label="Featured" className="flex flex-col gap-3">
          <FeatureBanners banners={features} />
        </section>
      ) : null}

      {topLevel.length > 0 ? (
        <section aria-labelledby="shop-by-category" className="flex flex-col gap-3">
          <h2 id="shop-by-category" className="display text-2xl font-bold uppercase">
            Shop by category
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topLevel.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/c/${category.slug}`}
                  className="flex h-full min-h-[88px] flex-col justify-between rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 hover:border-[var(--muted)]"
                >
                  <span className="display text-xl font-bold uppercase">{category.name}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {category.product_count} product{category.product_count === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="in-stock-now" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="in-stock-now" className="display text-2xl font-bold uppercase">
            In stock now
          </h2>
          <Link href="/search" className="text-sm font-medium text-[var(--ember)] underline-offset-2 hover:underline">
            See everything
          </Link>
        </div>
        {featured && featured.items.length > 0 ? (
          <ProductGrid products={featured.items} />
        ) : (
          <p className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-10 text-center text-[var(--muted)]">
            Nothing is available to order online right now. Come and see us in store.
          </p>
        )}
      </section>
    </div>
  );
}
