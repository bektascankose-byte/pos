"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCustomerAction } from "../actions";

export function NewCustomerClient() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Add a customer</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        A phone number or an email is required — one of the two is how the register finds someone again.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const outcome = await createCustomerAction(formData);
            if (outcome.ok) router.push(`/customers/${outcome.data.id}`);
            else setError(outcome.error);
          });
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name" name="first_name" />
          <Field label="Last name" name="last_name" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Phone" name="phone" placeholder="(512) 555-0123" />
          <Field label="Email" name="email" placeholder="name@example.com" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Birthday month" name="birth_month" placeholder="1–12" />
          <Field label="Birthday day" name="birth_day" placeholder="1–31" />
        </div>
        <Field label="Tags (comma separated)" name="tags" placeholder="wholesale, vip" />
        <Field label="Notes" name="notes" textarea />

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Adding..." : "Add customer"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  textarea,
}: {
  label: string;
  name: string;
  placeholder?: string;
  textarea?: boolean;
}) {
  const className =
    "rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {textarea ? (
        <textarea name={name} placeholder={placeholder} rows={3} className={className} />
      ) : (
        <input name={name} placeholder={placeholder} className={className} />
      )}
    </label>
  );
}
