import { apiFetch, ApiError } from "@/lib/api";
import type { BrandWithLogo } from "@snappos/contracts";
import { BrandsClient } from "./BrandsClient";

export default async function BrandsPage() {
  let brands: BrandWithLogo[] = [];
  let error: string | null = null;
  try {
    brands = await apiFetch<BrandWithLogo[]>("/api/v1/catalog/brand-logos");
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load brands.";
  }

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;

  return <BrandsClient initialBrands={brands} />;
}
