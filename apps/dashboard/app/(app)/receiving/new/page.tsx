import { apiFetch } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { createSessionAction } from "../actions";
import type { Vendor } from "@snappos/contracts";

export default async function NewReceivingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const storeId = await primaryStoreId();
  const vendors = await apiFetch<Vendor[]>(`/api/v1/purchasing/vendors`).catch(() => []);

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Receive a delivery</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        Start counting straight away. The vendor and the invoice are both optional — attach them
        whenever the paperwork turns up.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        action={createSessionAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        <label className="flex flex-col gap-1 text-sm">
          Reference
          <input
            name="reference"
            placeholder="Packing slip number, or what's on the box"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Vendor (optional)
          <select
            name="vendor_id"
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            <option value="">Don&apos;t know yet</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Note
          <input
            name="note"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Start counting
        </button>
      </form>
    </div>
  );
}
