import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Vendor, StockLevelRow } from "@snappos/contracts";
import { NewPurchaseOrderClient } from "./NewPurchaseOrderClient";

export default async function NewPurchaseOrderPage() {
  let vendors: Vendor[] = [];
  let variants: StockLevelRow[] = [];
  let storeId: string | null = null;
  let loadError: string | null = null;
  try {
    storeId = await primaryStoreId();
    [vendors, variants] = await Promise.all([
      apiFetch<Vendor[]>(`/api/v1/purchasing/vendors`),
      storeId ? apiFetch<StockLevelRow[]>(`/api/v1/inventory/stock?store_id=${storeId}`) : Promise.resolve([]),
    ]);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load vendors or products.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return <NewPurchaseOrderClient initialVendors={vendors} variants={variants} storeId={storeId} />;
}
