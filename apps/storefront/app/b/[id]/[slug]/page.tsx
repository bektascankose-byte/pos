import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import type { ShopProductList } from "@snappos/contracts";
import { Listing, listingQuery } from "@/components/Listing";
import { ShopApiError, shopFetch } from "@/lib/api";
import { brandHref } from "@/lib/format";

export const dynamic = "force-dynamic";

type Params = { id: string; slug: string };
type Search = { sort?: string; in_stock?: string; page?: string };

async function loadBrand(id: string) {
  try {
    return await shopFetch<{ id: string; name: string; product_count: number }>(`/brands/${encodeURIComponent(id)}`, {
      withCart: false,
      withSession: false,
    });
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) return null;
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await params;
  const brand = await loadBrand(id);
  return { title: brand?.name ?? "Brand" };
}

export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { id, slug } = await params;
  const search = await searchParams;
  const brand = await loadBrand(id);
  if (!brand) notFound();

  // One address per brand, whatever name was in the link that got here.
  const canonical = brandHref(brand.id, brand.name);
  if (`/b/${id}/${slug}` !== canonical) permanentRedirect(canonical);

  const list = await shopFetch<ShopProductList>(
    `/products?brand=${encodeURIComponent(id)}&${listingQuery(search)}`,
    { withCart: false, withSession: false },
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="eyebrow">Brand</p>
        <h1 className="display text-4xl font-extrabold uppercase sm:text-5xl">{brand.name}</h1>
      </div>
      <Listing basePath={canonical} list={list} params={search} />
    </div>
  );
}
