import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { PurchaseOrder } from "@snappos/contracts";
import { PurchaseOrderClient } from "./PurchaseOrderClient";

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let po: PurchaseOrder;
  try {
    po = await apiFetch<PurchaseOrder>(`/api/v1/purchasing/purchase-orders/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <PurchaseOrderClient poId={id} initialPo={po} />;
}
