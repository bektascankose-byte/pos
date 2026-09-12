import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Customer } from "@snappos/contracts";
import { updateCustomerAction } from "../actions";

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;

  let customer: Customer;
  try {
    customer = await apiFetch<Customer>(`/api/v1/customers/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const action = updateCustomerAction.bind(null, id);

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold">
        {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Customer"}
      </h1>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        action={action}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p className="text-xs text-[var(--color-text-muted)]">
          Leave a field blank to keep its current value.
        </p>
        <Field label="First name" name="first_name" defaultValue={customer.first_name ?? ""} />
        <Field label="Last name" name="last_name" defaultValue={customer.last_name ?? ""} />
        <Field label="Phone" name="phone" defaultValue={customer.phone ?? ""} />
        <Field label="Email" name="email" defaultValue={customer.email ?? ""} />
        <Field label="Notes" name="notes" defaultValue={customer.notes ?? ""} textarea />
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Save
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  textarea,
}: {
  label: string;
  name: string;
  defaultValue: string;
  textarea?: boolean;
}) {
  const className =
    "rounded-md border border-[var(--color-border)] px-3 py-2 outline-none focus:border-[var(--color-accent)]";
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {textarea ? (
        <textarea name={name} defaultValue={defaultValue} rows={3} className={className} />
      ) : (
        <input name={name} defaultValue={defaultValue} className={className} />
      )}
    </label>
  );
}
