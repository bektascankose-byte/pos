import { apiFetch, ApiError } from "@/lib/api";
import type { Role } from "@snappos/contracts";
import { createEmployeeAction } from "../actions";

export default async function NewEmployeePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  let roles: Role[] = [];
  let loadError: string | null = null;
  try {
    roles = await apiFetch<Role[]>(`/api/v1/employees/roles`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load roles.";
  }

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Add employee</h1>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <form
        action={createEmployeeAction}
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
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Create employee
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
