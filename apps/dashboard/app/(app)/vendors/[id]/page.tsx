import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { VendorDetail } from "@snappos/contracts";
import { VendorDetailClient } from "./VendorDetailClient";

export default async function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let vendor: VendorDetail;
  try {
    vendor = await apiFetch<VendorDetail>(`/api/v1/purchasing/vendors/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <VendorDetailClient vendorId={id} vendor={vendor} />;
}
