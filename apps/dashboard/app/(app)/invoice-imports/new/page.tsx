import { primaryStoreId } from "@/lib/store";
import { uploadInvoiceAction } from "../actions";

export default async function NewInvoiceImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const storeId = await primaryStoreId();

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Upload invoice</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        PDF, PNG, JPG, CSV, or a plain text EDI file. Only CSV can be parsed into line items right
        now -- other formats are stored and ready for when that's built.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        action={uploadInvoiceAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
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
