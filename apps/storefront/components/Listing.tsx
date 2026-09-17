import Link from "next/link";
import type { ShopProductList } from "@snappos/contracts";
import { ProductGrid } from "./ProductCard";

export const SORTS = [
  { value: "featured", label: "Featured" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
] as const;

/**
 * A page of products with sorting, an in-stock filter and pagination.
 *
 * All of it is plain links and a GET form, so it works without JavaScript and
 * every state has a URL that can be shared or bookmarked.
 */
export function Listing({
  basePath,
  list,
  params,
  hidden = {},
}: {
  basePath: string;
  list: ShopProductList;
  params: { sort?: string; in_stock?: string; page?: string; q?: string };
  /** Query parameters the page's own filters must keep, such as a search term. */
  hidden?: Record<string, string>;
}) {
  const pages = Math.max(Math.ceil(list.total / list.page_size), 1);
  const hrefFor = (page: number) => {
    const search = new URLSearchParams({
      ...hidden,
      ...(params.sort ? { sort: params.sort } : {}),
      ...(params.in_stock ? { in_stock: params.in_stock } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
    });
    const qs = search.toString();
    return `${basePath}${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-3">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label className="flex flex-col gap-1 text-sm" htmlFor="sort">
          <span className="text-[var(--muted)]">Sort by</span>
          <select id="sort" name="sort" defaultValue={params.sort ?? "featured"} className="field w-auto">
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm" htmlFor="in_stock">
          <input id="in_stock" type="checkbox" name="in_stock" value="true" defaultChecked={params.in_stock === "true"} className="h-5 w-5" />
          In stock only
        </label>
        <button type="submit" className="btn btn-quiet text-sm">
          Apply
        </button>
        <p className="ml-auto text-sm text-[var(--muted)]" aria-live="polite">
          {list.total} product{list.total === 1 ? "" : "s"}
        </p>
      </form>

      {list.items.length > 0 ? (
        <ProductGrid products={list.items} />
      ) : (
        <p className="rounded-2xl border border-dashed border-[var(--line)] px-4 py-10 text-center text-[var(--muted)]">
          Nothing here matches right now.
        </p>
      )}

      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-center gap-2">
          {list.page > 1 ? (
            <Link href={hrefFor(list.page - 1)} className="btn btn-quiet text-sm" rel="prev">
              Previous
            </Link>
          ) : null}
          <span className="tabular text-sm text-[var(--muted)]">
            Page {list.page} of {pages}
          </span>
          {list.page < pages ? (
            <Link href={hrefFor(list.page + 1)} className="btn btn-quiet text-sm" rel="next">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/** Query parameters for the API, from the page's own. */
export function listingQuery(params: { sort?: string; in_stock?: string; page?: string }): string {
  const search = new URLSearchParams({ page_size: "24" });
  if (params.sort && SORTS.some((sort) => sort.value === params.sort)) search.set("sort", params.sort);
  if (params.in_stock === "true") search.set("in_stock", "true");
  const page = Number.parseInt(params.page ?? "1", 10);
  if (page > 1) search.set("page", String(page));
  return search.toString();
}
