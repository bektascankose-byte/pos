import type { Metadata } from "next";
import type { ShopProductList } from "@snappos/contracts";
import { Listing, listingQuery } from "@/components/Listing";
import { shopFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

type Search = { q?: string; sort?: string; in_stock?: string; page?: string };

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `Search: ${q}` : "All products", robots: { index: false } };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const q = (search.q ?? "").trim().slice(0, 100);
  const list = await shopFetch<ShopProductList>(
    `/products?${q ? `q=${encodeURIComponent(q)}&` : ""}${listingQuery(search)}`,
    { withCart: false, withSession: false },
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="display text-4xl font-extrabold uppercase sm:text-5xl">
        {q ? <>Results for “{q}”</> : "All products"}
      </h1>
      <Listing basePath="/search" list={list} params={search} hidden={q ? { q } : {}} />
    </div>
  );
}
