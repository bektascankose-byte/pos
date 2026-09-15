import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type {
  ReceivingSession,
  Category,
  Brand,
  PriceCategory,
  InvoiceImport,
} from "@snappos/contracts";
import { ReceivingDetailClient } from "./ReceivingDetailClient";

export default async function ReceivingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let session: ReceivingSession;
  try {
    session = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const storeId = await primaryStoreId();
  const priceGroupQuery = storeId ? `?store_id=${storeId}` : "";

  // All optional to the job at hand: scanning works without any of them, so a
  // slow or failing lookup call must not take the page down mid-delivery.
  const [categories, brands, priceGroups, invoices] = await Promise.all([
    apiFetch<Category[]>(`/api/v1/catalog/categories`).catch(() => []),
    apiFetch<Brand[]>(`/api/v1/catalog/brands`).catch(() => []),
    apiFetch<PriceCategory[]>(`/api/v1/catalog/price-categories${priceGroupQuery}`).catch(() => []),
    apiFetch<InvoiceImport[]>(`/api/v1/invoice-imports`).catch(() => []),
  ]);

  return (
    <ReceivingDetailClient
      initialSession={session}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      brands={brands.map((b) => ({ id: b.id, name: b.name }))}
      priceGroups={priceGroups.map((group) => ({
        id: group.id,
        // Unnamed groups are the norm — "Price selected together" makes them —
        // so they're labelled by the price they carry, the same as everywhere
        // else a price group has to be picked from a list.
        name:
          group.name ??
          (group.current_price_minor !== null
            ? `$${BigInt(String(group.current_price_minor)) / 100n}.${(BigInt(String(group.current_price_minor)) % 100n).toString().padStart(2, "0")} · ${group.member_count} items`
            : `Mixed prices · ${group.member_count} items`),
        price_minor:
          group.current_price_minor === null ? null : String(group.current_price_minor),
      }))}
      // Only invoices that have actually been parsed can be compared — an
      // uploaded-but-unparsed one has no lines to match against.
      invoices={invoices.filter((invoice) => invoice.status !== "uploaded" && invoice.status !== "failed")}
    />
  );
}
