import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Customer } from "@snappos/contracts";
import { CustomerDetailClient } from "./CustomerDetailClient";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let customer: Customer;
  try {
    customer = await apiFetch<Customer>(`/api/v1/customers/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return <CustomerDetailClient customerId={id} initialCustomer={customer} />;
}
