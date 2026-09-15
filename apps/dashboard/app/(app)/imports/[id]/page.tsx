import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { ImportJob } from "@snappos/contracts";
import { ImportReviewClient } from "./ImportReviewClient";

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let job: ImportJob;
  try {
    job = await apiFetch<ImportJob>(`/api/v1/data-transfer/imports/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <ImportReviewClient importId={id} initialJob={job} />;
}
