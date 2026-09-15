"use client";

import { useState, useTransition } from "react";
import { setCustomerStatusAction, updateCustomerAction } from "../actions";
import type { Customer } from "@snappos/contracts";

export function CustomerDetailClient({ customerId, initialCustomer }: { customerId: string; initialCustomer: Customer }) {
  const [customer, setCustomer] = useState(initialCustomer);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [statusPending, startStatusTransition] = useTransition();
  const archived = customer.status === "archived";

  const toggleArchived = () => {
    setMessage(null);
    startStatusTransition(async () => {
      const result = await setCustomerStatusAction(customerId, archived ? "active" : "archived");
      if (result.ok) {
        setCustomer(result.data);
        setMessage({
          kind: "success",
          text: archived ? "Restored." : "Archived. Their past sales are untouched.",
        });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateCustomerAction(customerId, formData);
      if (result.ok) {
        setCustomer(result.data);
        setMessage({ kind: "success", text: "Saved." });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Customer"}
          </h1>
          {archived ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Archived — hidden from search here and at the register.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={statusPending}
          onClick={toggleArchived}
          title={
            archived
              ? "Put this customer back in search"
              : "Hide from search everywhere. Past sales and receipts are kept."
          }
          className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
        >
          {statusPending ? "Saving..." : archived ? "Restore" : "Archive"}
        </button>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p className="text-xs text-[var(--color-text-muted)]">
          Leave a field blank to keep its current value.
        </p>
        <Field label="First name" name="first_name" defaultValue={customer.first_name ?? ""} />
        <Field label="Last name" name="last_name" defaultValue={customer.last_name ?? ""} />
        <Field label="Phone" name="phone" defaultValue={customer.phone ?? ""} />
        <Field label="Email" name="email" defaultValue={customer.email ?? ""} />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Birthday month"
            name="birth_month"
            defaultValue={customer.birth_month === null ? "" : String(customer.birth_month)}
          />
          <Field
            label="Birthday day"
            name="birth_day"
            defaultValue={customer.birth_day === null ? "" : String(customer.birth_day)}
          />
        </div>
        <Field label="Tags (comma separated)" name="tags" defaultValue={customer.tags.join(", ")} />
        <Field label="Notes" name="notes" defaultValue={customer.notes ?? ""} textarea />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save"}
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
