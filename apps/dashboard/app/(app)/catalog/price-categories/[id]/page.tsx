import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { PriceCategoryClient, type CategoryWithMembers } from "./PriceCategoryClient";

export default async function PriceCategoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storeId = await primaryStoreId();

  let category: CategoryWithMembers;
  try {
    const qs = storeId ? `?store_id=${storeId}` : "";
    category = await apiFetch<CategoryWithMembers>(`/api/v1/catalog/price-categories/${id}${qs}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <PriceCategoryClient categoryId={id} initialCategory={category} />;
}
