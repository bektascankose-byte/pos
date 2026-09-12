import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { Customer } from "@snappos/contracts";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";

  let customers: Customer[] = [];
  let error: string | null = null;
  try {
    const result = await apiFetch<{ data: Customer[] }>(`/api/v1/customers${qs}`);
    customers = result.data;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load customers.";
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Customers</h1>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by name, email, or phone"
          className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
        >
          Search
        </button>
      </form>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Phone</th>
              <th className="px-4 py-2 font-normal">Email</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/customers/${customer.id}`} className="text-[var(--color-accent)]">
                    {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || "—"}
                  </Link>
                </td>
                <td className="px-4 py-2">{customer.phone ?? "—"}</td>
                <td className="px-4 py-2">{customer.email ?? "—"}</td>
              </tr>
            ))}
            {customers.length === 0 && !error ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  {q ? `No match for "${q}".` : "No customers yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
