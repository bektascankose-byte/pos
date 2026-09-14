"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createEmployeeAction } from "../actions";
import type { Role } from "@snappos/contracts";

export function NewEmployeeClient({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createEmployeeAction(formData);
      if (result.ok) {
        router.push(`/employees/${result.data.id}?saved=1`);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Add employee</h1>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <Field label="Full name" name="full_name" required />
        <Field label="Email" name="email" placeholder="optional if phone is given" />
        <Field label="Phone" name="phone" placeholder="+15125550123, optional if email is given" />
        <label className="flex flex-col gap-1 text-sm">
          Role
          <select
            name="role_key"
            required
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Register PIN (4-8 digits)" name="pin" placeholder="optional" />
        <Field label="Dashboard password" name="password" type="password" placeholder="optional" />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Creating..." : "Create employee"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
