import { primaryStoreId } from "@/lib/store";
import { uploadImportAction } from "../actions";

/**
 * `entity` arrives in the query string because this page is reached from the
 * Items list and from the Customers list, and each one knows what it is
 * importing. Defaults to items when someone lands here directly.
 */
export default async function NewImportPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; error?: string }>;
}) {
  const { entity: rawEntity, error } = await searchParams;
  const entity = rawEntity === "customer" ? "customer" : "item";
  const storeId = await primaryStoreId();
  const noun = entity === "customer" ? "customers" : "items";

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Import {noun}</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        A CSV or Excel file, with column headings in the first row. Nothing is imported when you
        upload — the next screen shows which column it read as which field, and what the import
        would do, before anything is written.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        action={uploadImportAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="entity" value={entity} />
        {entity === "item" ? <input type="hidden" name="store_id" value={storeId ?? ""} /> : null}
        <label className="flex flex-col gap-1 text-sm">
          File
          <input
            type="file"
            name="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button
          type="submit"
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Upload and check
        </button>
      </form>

      {entity === "item" ? (
        <div className="rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
          <p className="mb-2 font-medium text-[var(--color-text)]">What an item import does</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Rows are matched on SKU. A SKU already in the catalog is updated; a new one is created.</li>
            <li>Only columns you map are touched — a price list with just costs won&apos;t blank anything else.</li>
            <li>A price change is recorded in the item&apos;s price history, the same as typing it in.</li>
            <li>Stock counts are not imported here. Bring those in through an inventory count.</li>
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
          <p className="mb-2 font-medium text-[var(--color-text)]">What a customer import does</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Rows are matched on phone, then email. A match is updated; anything else is created.</li>
            <li>A row with neither a phone nor an email is skipped — there&apos;d be no way to find them again.</li>
            <li>Tags are added to whatever a matched customer already has, never replaced.</li>
            <li>
              Imported customers are <strong>not</strong> opted in to marketing. A spreadsheet isn&apos;t
              consent, and sending to a list that never opted in is what gets shops fined.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
