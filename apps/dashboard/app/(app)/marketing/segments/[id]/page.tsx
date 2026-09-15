import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Segment } from "@snappos/contracts";
import { SegmentEditor } from "../../SegmentEditor";
import { segmentOptions } from "../../options";

export default async function EditSegmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let segment: Segment;
  try {
    segment = await apiFetch<Segment>(`/api/v1/marketing/segments/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const { products, categories } = await segmentOptions();
  return <SegmentEditor segment={segment} products={products} categories={categories} />;
}
