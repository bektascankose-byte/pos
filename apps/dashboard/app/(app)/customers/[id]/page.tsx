import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Customer, ConsentState, CustomerHistory } from "@snappos/contracts";
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

  // Consent and history are separate calls so a failure in either still
  // leaves the record itself editable -- the page's main job.
  const [consents, history] = await Promise.all([
    apiFetch<ConsentState[]>(`/api/v1/customers/${id}/consents`).catch(() => null),
    apiFetch<CustomerHistory>(`/api/v1/customers/${id}/history`).catch(() => null),
  ]);

  return (
    <CustomerDetailClient
      customerId={id}
      initialCustomer={customer}
      consents={consents}
      history={history}
    />
  );
}
