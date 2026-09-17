import { notFound, permanentRedirect } from "next/navigation";
import { ShopApiError, shopFetch } from "@/lib/api";
import { brandHref } from "@/lib/format";

/** A brand link without its readable name. */
export default async function BrandShortLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    const brand = await shopFetch<{ id: string; name: string }>(`/brands/${id}`, { withCart: false, withSession: false });
    permanentRedirect(brandHref(brand.id, brand.name));
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) notFound();
    throw e;
  }
}
