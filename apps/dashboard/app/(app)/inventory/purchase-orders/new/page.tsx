import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { createPurchaseOrderAction, createVendorAction } from "../actions";
import type { Vendor, StockLevelRow } from "@snappos/contracts";

const LINE_ROWS = 8;

function suggestedReference(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(100 + Math.random() * 900);
  return `PO-${today}-${suffix}`;
}

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; vendorSaved?: string }>;
}) {
  const { error, vendorSaved } = await searchParams;

  let vendors: Vendor[] = [];
  let variants: StockLevelRow[] = [];
  let storeId: string | null = null;
  let loadError: string | null = null;
  try {
    storeId = await primaryStoreId();
    [vendors, variants] = await Promise.all([
      apiFetch<Vendor[]>(`/api/v1/purchasing/vendors`),
      storeId ? apiFetch<StockLevelRow[]>(`/api/v1/inventory/stock?store_id=${storeId}`) : Promise.resolve([]),
    ]);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load vendors or products.";
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold">New purchase order</h1>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}
      {vendorSaved ? <p className="text-sm text-[var(--color-success)]">Vendor added.</p> : null}

      {vendors.length === 0 ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">
            No vendors yet -- add one first
          </h2>
          <form action={createVendorAction} className="grid grid-cols-2 gap-4">
            <Field label="Code" name="code" required />
            <Field label="Name" name="name" required />
            <Field label="Phone" name="phone" />
            <Field label="Email" name="email" />
            <button
              type="submit"
              className="col-span-2 self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
            >
              Add vendor
            </button>
          </form>
        </section>
      ) : (
        <form
          action={createPurchaseOrderAction}
          className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <input type="hidden" name="store_id" value={storeId ?? ""} />
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Vendor
              <select
                name="vendor_id"
                required
                defaultValue=""
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              >
                <option value="" disabled>
                  Choose a vendor
                </option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <Field label="Reference" name="reference" defaultValue={suggestedReference()} required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Expected date
              <input
                type="date"
                name="expected_at"
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <Field label="Note" name="note" />
          </div>

          <div className="mt-2 flex flex-col gap-2">
            <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Line items</h2>
            <div className="grid grid-cols-[1fr_120px_120px] gap-2 text-xs text-[var(--color-text-muted)]">
              <span>Product</span>
              <span>Quantity</span>
              <span>Unit cost</span>
            </div>
            {Array.from({ length: LINE_ROWS }, (_, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_120px] gap-2">
                <select
                  name={`variant_id_${i}`}
                  defaultValue=""
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">—</option>
                  {variants.map((v) => (
                    <option key={v.variant_id} value={v.variant_id}>
                      {v.product_name}
                      {v.variant_name ? ` — ${v.variant_name}` : ""} ({v.sku})
                    </option>
                  ))}
                </select>
                <input
                  name={`quantity_${i}`}
                  placeholder="qty"
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                <input
                  name={`unit_cost_${i}`}
                  placeholder="cost"
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            ))}
          </div>

          <button
            type="submit"
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Create purchase order
          </button>
        </form>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
