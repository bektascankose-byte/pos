import { notFound, permanentRedirect } from "next/navigation";
import type { ShopProductDetail } from "@snappos/contracts";
import { ShopApiError, shopFetch } from "@/lib/api";
import { productHref } from "@/lib/format";

/** A product link without its readable name, as a scanner or a shortened link might produce. */
export default async function ProductShortLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    const product = await shopFetch<ShopProductDetail>(`/products/${id}`, { withCart: false, withSession: false });
    permanentRedirect(productHref(product.id, product.name));
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) notFound();
    throw e;
  }
}
