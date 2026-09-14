import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { StockLevelRow, LedgerEntry } from "@snappos/contracts";
import { InventoryDetailClient } from "./InventoryDetailClient";

export default async function InventoryDetailPage({ params }: { params: Promise<{ variantId: string }> }) {
  const { variantId } = await params;

  const storeId = await primaryStoreId();
  if (!storeId) notFound();

  let stock: StockLevelRow;
  let ledger: LedgerEntry[] = [];
  try {
    [stock, ledger] = await Promise.all([
      apiFetch<StockLevelRow>(`/api/v1/inventory/stock/${variantId}?store_id=${storeId}`),
      apiFetch<LedgerEntry[]>(`/api/v1/inventory/ledger?variant_id=${variantId}&limit=20`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <InventoryDetailClient variantId={variantId} storeId={storeId} stock={stock} ledger={ledger} />;
}
