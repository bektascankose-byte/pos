import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseInvoiceAction, matchInvoiceAction } from "../actions";
import type { InvoiceImport } from "@snappos/contracts";

export default async function InvoiceImportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;

  let invoiceImport: InvoiceImport;
  try {
    invoiceImport = await apiFetch<InvoiceImport>(`/api/v1/invoice-imports/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const parseInvoice = parseInvoiceAction.bind(null, id);
  const matchInvoice = matchInvoiceAction.bind(null, id);
  const lines = invoiceImport.lines ?? [];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{invoiceImport.source_filename}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          <span className="uppercase">{invoiceImport.source_format}</span> ·{" "}
          <span className="capitalize">{invoiceImport.status}</span> ·{" "}
          {new Date(invoiceImport.created_at).toLocaleString()}
        </p>
      </div>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {invoiceImport.parse_error ? (
        <p className="text-sm text-[var(--color-error)]">Parse error: {invoiceImport.parse_error}</p>
      ) : null}

      <div className="flex gap-2">
        {invoiceImport.status === "uploaded" || invoiceImport.status === "failed" ? (
          <form action={parseInvoice}>
            <button
              type="submit"
              className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
            >
              Parse this invoice
            </button>
          </form>
        ) : null}
        {lines.length > 0 ? (
          <form action={matchInvoice}>
            <button
              type="submit"
              className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
            >
              Find matches
            </button>
          </form>
        ) : null}
      </div>
      {lines.length > 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Matching checks an exact barcode, then this vendor&apos;s own SKU mapping, then a fuzzy
          match on the description against your catalog -- no AI involved yet. A suggestion is
          never applied automatically; review and commit come later.
        </p>
      ) : null}

      {lines.length > 0 ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
            Lines
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Raw text</th>
                <th className="px-4 py-2 font-normal">Vendor SKU</th>
                <th className="px-4 py-2 font-normal">Qty</th>
                <th className="px-4 py-2 font-normal">Unit cost</th>
                <th className="px-4 py-2 font-normal">Suggested match</th>
                <th className="px-4 py-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--color-border)] align-top">
                  <td className="max-w-md px-4 py-2 text-xs text-[var(--color-text-muted)]">
                    {line.raw_text}
                  </td>
                  <td className="px-4 py-2">{line.parsed_vendor_sku ?? "—"}</td>
                  <td className="px-4 py-2 tabular-nums">{line.parsed_quantity ?? "—"}</td>
                  <td className="px-4 py-2 tabular-nums">{line.parsed_unit_cost ?? "—"}</td>
                  <td className="px-4 py-2">
                    {line.ai_suggested_product_name ? (
                      <>
                        {line.ai_suggested_product_name}
                        {line.ai_suggested_variant_name ? ` — ${line.ai_suggested_variant_name}` : ""}
                        <span className="block text-xs text-[var(--color-text-muted)]">
                          {line.ai_confidence !== null ? `${Math.round(line.ai_confidence * 100)}% confidence` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">no match yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2 capitalize">{line.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
