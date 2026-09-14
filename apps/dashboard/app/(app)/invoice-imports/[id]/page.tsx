import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { InvoiceImport, Category } from "@snappos/contracts";
import { InvoiceImportClient } from "./InvoiceImportClient";

interface VariantOption {
  variant_id: string;
  product_id: string;
  sku: string;
  variant_name: string | null;
  product_name: string;
}

export default async function InvoiceImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let invoiceImport: InvoiceImport;
  try {
    invoiceImport = await apiFetch<InvoiceImport>(`/api/v1/invoice-imports/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const lines = invoiceImport.lines ?? [];
  const editable = invoiceImport.status !== "committed";

  let variants: VariantOption[] = [];
  let categories: Category[] = [];
  if (editable && lines.length > 0) {
    try {
      const [variantResult, categoryResult] = await Promise.all([
        apiFetch<{ data: VariantOption[] }>(`/api/v1/catalog/products?limit=200`),
        apiFetch<Category[]>(`/api/v1/catalog/categories`),
      ]);
      variants = variantResult.data;
      categories = categoryResult;
    } catch {
      // A page with no options to pick from still lets the rest of it work.
    }
  }
  const products = [...new Map(variants.map((v) => [v.product_id, v])).values()];

  return (
    <InvoiceImportClient
      importId={id}
      initialImport={invoiceImport}
      variants={variants}
      products={products}
      categories={categories}
    />
  );
}
