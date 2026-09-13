import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { InvoiceImport } from "@snappos/contracts";

export default async function InvoiceImportsPage() {
  let imports: InvoiceImport[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    imports = storeId
      ? await apiFetch<InvoiceImport[]>(`/api/v1/invoice-imports?store_id=${storeId}`)
      : [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load invoice imports.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Invoice imports</h1>
        <Link
          href="/invoice-imports/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Upload invoice
        </Link>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        CSV invoices parse into line items you can review. PDF/image extraction and AI-assisted
        catalog matching aren&apos;t built yet -- uploading those formats stores the file, but
        parsing one still returns a clear "not built yet" error rather than a guess.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">File</th>
              <th className="px-4 py-2 font-normal">Format</th>
              <th className="px-4 py-2 font-normal">Vendor</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {imports.map((imp) => (
              <tr key={imp.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/invoice-imports/${imp.id}`} className="text-[var(--color-accent)]">
                    {imp.source_filename}
                  </Link>
                </td>
                <td className="px-4 py-2 uppercase">{imp.source_format}</td>
                <td className="px-4 py-2">{imp.vendor_name ?? "—"}</td>
                <td className="px-4 py-2 capitalize">{imp.status}</td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(imp.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {imports.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No invoices uploaded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
