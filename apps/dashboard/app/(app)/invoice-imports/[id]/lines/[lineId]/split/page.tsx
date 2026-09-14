import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { InvoiceImport } from "@snappos/contracts";
import { SplitLineClient } from "./SplitLineClient";

interface VariantOption {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_name: string;
}

export default async function SplitLinePage({ params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;

  let invoiceImport: InvoiceImport;
  try {
    invoiceImport = await apiFetch<InvoiceImport>(`/api/v1/invoice-imports/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const line = (invoiceImport.lines ?? []).find((l) => l.id === lineId);
  if (!line) notFound();

  let variants: VariantOption[] = [];
  let loadError: string | null = null;
  try {
    const result = await apiFetch<{ data: VariantOption[] }>(`/api/v1/catalog/products?limit=200`);
    variants = result.data;
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load the catalog's variants.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return <SplitLineClient importId={id} line={line} variants={variants} />;
}
