import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { uploadInvoiceAction } from "../actions";
import type { Vendor } from "@snappos/contracts";

export default async function NewInvoiceImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const storeId = await primaryStoreId();

  let vendors: Vendor[] = [];
  let loadError: string | null = null;
  try {
    vendors = await apiFetch<Vendor[]>(`/api/v1/purchasing/vendors`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load vendors.";
  }

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Upload invoice</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        PDF, CSV, or a plain text EDI file parse into line items automatically. PNG/JPG images are
        stored and ready for when OCR is built, but can't be parsed yet.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <form
        action={uploadInvoiceAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        <label className="flex flex-col gap-1 text-sm">
          Vendor
          <select
            name="vendor_id"
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">Unknown / pick later</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--color-text-muted)]">
            Picking the vendor lets matching remember this vendor&apos;s own SKUs across invoices, and
            is required before this import can be committed.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          File
          <input
            type="file"
            name="file"
            accept=".pdf,.png,.jpg,.jpeg,.csv,.txt,application/pdf,image/png,image/jpeg,text/csv,text/plain"
            required
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Upload
        </button>
      </form>
    </div>
  );
}
