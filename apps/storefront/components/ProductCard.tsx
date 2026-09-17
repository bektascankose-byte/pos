import Link from "next/link";
import type { ShopProductCard, ShopStock } from "@snappos/contracts";
import { priceRange, productHref } from "@/lib/format";

export function StockLabel({ stock }: { stock: ShopStock }) {
  const text = stock === "in_stock" ? "In stock" : stock === "low_stock" ? "Only a few left" : "Out of stock";
  const colour =
    stock === "in_stock" ? "text-[var(--ok)]" : stock === "low_stock" ? "text-[var(--warn)]" : "text-[var(--muted)]";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${colour}`}>
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

/** "21+", set like the corner of an ID card, because that is what will be asked for. */
export function AgeBadge({ age }: { age: number }) {
  return (
    <span
      className="display inline-flex items-center rounded border border-[var(--ink)] px-1.5 text-xs font-bold leading-5"
      title={`You must be ${age} or older. Photo ID is checked at pickup.`}
    >
      {age}+<span className="sr-only"> only, photo ID checked at pickup</span>
    </span>
  );
}

export function ProductImage({
  imageId,
  name,
  size = "thumb",
  className = "",
}: {
  imageId: string | null;
  name: string;
  size?: "thumb" | "full";
  className?: string;
}) {
  if (imageId) {
    // A plain img, not next/image: photos arrive through /img already sized by
    // the back office, so there is nothing for an image optimiser to do.
    return (
      <img
        src={`/img/${imageId}?size=${size}`}
        alt=""
        loading="lazy"
        decoding="async"
        className={`h-full w-full object-contain ${className}`}
      />
    );
  }
  // Only words that start with a letter or digit: "Snickers | Share Size" is SS, not S|.
  const initials = name
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return (
    <span aria-hidden="true" className={`display flex h-full w-full items-center justify-center text-4xl font-bold text-[var(--muted)] ${className}`}>
      {initials}
    </span>
  );
}

export function ProductCard({ product }: { product: ShopProductCard }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
      <div className="aspect-square max-w-full bg-[var(--surface-sunk)] p-4">
        <ProductImage imageId={product.image_id} name={product.name} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow truncate">{product.brand?.name ?? product.category?.name ?? ""}</span>
          {product.minimum_age ? <AgeBadge age={product.minimum_age} /> : null}
        </div>
        <h3 className="font-semibold leading-snug">
          <Link href={productHref(product.id, product.name)} className="after:absolute after:inset-0">
            {product.name}
          </Link>
        </h3>
        {product.variant_count > 1 ? (
          <p className="text-xs text-[var(--muted)]">{product.variant_count} options</p>
        ) : null}
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <span className="tabular font-semibold">{priceRange(product.price_from_minor, product.price_to_minor)}</span>
          <StockLabel stock={product.stock} />
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({ products }: { products: ShopProductCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
      {products.map((product) => (
        <li key={product.id} className="flex">
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}
