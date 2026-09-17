import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { ShopProductDetail } from "@snappos/contracts";
import { AddToCart } from "@/components/AddToCart";
import { AgeBadge, ProductImage } from "@/components/ProductCard";
import { ShopApiError, shopFetch } from "@/lib/api";
import { brandHref, priceRange, productHref } from "@/lib/format";

export const dynamic = "force-dynamic";

type Params = { id: string; slug: string };

async function loadProduct(id: string): Promise<ShopProductDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    return await shopFetch<ShopProductDetail>(`/products/${id}`, { withCart: false, withSession: false });
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) return null;
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await params;
  const product = await loadProduct(id);
  if (!product) return { title: "Not found" };
  return {
    title: product.name,
    description:
      product.description?.slice(0, 160) ??
      `${product.name}${product.brand ? ` by ${product.brand.name}` : ""}. Order online and pick up in store.`,
    alternates: { canonical: productHref(product.id, product.name) },
  };
}

export default async function ProductPage({ params }: { params: Promise<Params> }) {
  const { id, slug } = await params;
  const product = await loadProduct(id);
  if (!product) notFound();

  // The id decides which product; the words after it are for people and search
  // engines. A renamed product keeps its old links working by redirecting them.
  const canonical = productHref(product.id, product.name);
  if (`/p/${id}/${slug}` !== canonical) permanentRedirect(canonical);

  const [hero, ...gallery] = product.images;

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-[var(--muted)]">
        <ol className="flex flex-wrap gap-1">
          <li>
            <Link href="/" className="underline-offset-2 hover:underline">
              Home
            </Link>
            <span aria-hidden="true"> / </span>
          </li>
          {product.category ? (
            <li>
              <Link href={`/c/${product.category.slug}`} className="underline-offset-2 hover:underline">
                {product.category.name}
              </Link>
              <span aria-hidden="true"> / </span>
            </li>
          ) : null}
          <li aria-current="page">{product.name}</li>
        </ol>
      </nav>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="aspect-square max-w-full overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6">
            <ProductImage imageId={hero?.id ?? product.image_id} name={product.name} size="full" />
          </div>
          {gallery.length > 0 ? (
            <ul className="grid grid-cols-4 gap-2">
              {gallery.slice(0, 8).map((image) => (
                <li key={image.id} className="aspect-square max-w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2">
                  <ProductImage imageId={image.id} name={product.name} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            {product.brand ? (
              <Link href={brandHref(product.brand.id, product.brand.name)} className="eyebrow underline-offset-2 hover:underline">
                {product.brand.name}
              </Link>
            ) : null}
            <h1 className="display text-4xl font-extrabold uppercase sm:text-5xl">{product.name}</h1>
            <p className="tabular text-lg">{priceRange(product.price_from_minor, product.price_to_minor)}</p>
          </div>

          {product.minimum_age ? (
            <div className="flex items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm">
              <AgeBadge age={product.minimum_age} />
              <p>
                You must be {product.minimum_age} or older to buy this.
                {product.id_required ? " Bring a valid photo ID: we check it when you pick up." : ""}
              </p>
            </div>
          ) : null}

          <AddToCart variants={product.variants} />

          <p className="text-sm text-[var(--muted)]">
            Order online and pay when you pick up. We&apos;ll email you when it&apos;s ready.
          </p>

          {product.description ? (
            <section aria-labelledby="about" className="flex flex-col gap-2 border-t border-[var(--line)] pt-5">
              <h2 id="about" className="text-sm font-semibold">
                About this product
              </h2>
              <p className="whitespace-pre-line text-[var(--muted)]">{product.description}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
