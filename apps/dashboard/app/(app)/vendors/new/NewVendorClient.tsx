"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorAction } from "../actions";
import { VendorFields } from "../VendorFields";

export function NewVendorClient() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Add a vendor</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        A code and a name are all that&apos;s required. The code is the short one you&apos;ll see on
        purchase orders — an abbreviation of the name works well.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const outcome = await createVendorAction(formData);
            if (outcome.ok) router.push(`/vendors/${outcome.data.id}`);
            else setError(outcome.error);
          });
        }}
      >
        <VendorFields />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Adding..." : "Add vendor"}
        </button>
      </form>
    </div>
  );
}
