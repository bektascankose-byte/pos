import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ShopProductList } from "@snappos/contracts";
import { Listing, listingQuery } from "@/components/Listing";
import { shopFetch } from "@/lib/api";
import { getCategories } from "@/lib/shop";

export const dynamic = "force-dynamic";

type Params = { slug: string };
type Search = { sort?: string; in_stock?: string; page?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const category = (await getCategories()).find((c) => c.slug === slug);
  return { title: category?.name ?? "Category" };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const search = await searchParams;
  const categories = await getCategories();
  const category = categories.find((c) => c.slug === slug);
  if (!category) notFound();

  const children = categories.filter((c) => c.parent_id === category.id);
  const parent = categories.find((c) => c.id === category.parent_id);
  const list = await shopFetch<ShopProductList>(
    `/products?category=${encodeURIComponent(slug)}&${listingQuery(search)}`,
    { withCart: false, withSession: false },
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--muted)]">
          <ol className="flex flex-wrap gap-1">
            <li>
              <Link href="/" className="underline-offset-2 hover:underline">
                Home
              </Link>
              <span aria-hidden="true"> / </span>
            </li>
            {parent ? (
              <li>
                <Link href={`/c/${parent.slug}`} className="underline-offset-2 hover:underline">
                  {parent.name}
                </Link>
                <span aria-hidden="true"> / </span>
              </li>
            ) : null}
            <li aria-current="page">{category.name}</li>
          </ol>
        </nav>
        <h1 className="display text-4xl font-extrabold uppercase sm:text-5xl">{category.name}</h1>
        {children.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label={`Within ${category.name}`}>
            {children.map((child) => (
              <li key={child.id}>
                <Link href={`/c/${child.slug}`} className="btn btn-quiet text-sm">
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Listing basePath={`/c/${slug}`} list={list} params={search} />
    </div>
  );
}
