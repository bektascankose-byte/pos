import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import {
  parseInvoiceAction,
  matchInvoiceAction,
  resolveLineAction,
  ignoreLineAction,
  commitInvoiceAction,
} from "../actions";
import type { InvoiceImport, InvoiceImportLine } from "@snappos/contracts";

interface VariantOption {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_name: string;
}

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

  const lines = invoiceImport.lines ?? [];
  const editable = invoiceImport.status !== "committed";

  let variants: VariantOption[] = [];
  if (editable && lines.length > 0) {
    try {
      const result = await apiFetch<{ data: VariantOption[] }>(`/api/v1/catalog/products?limit=200`);
      variants = result.data;
    } catch {
      // A variant picker with no options still lets the rest of the page work.
    }
  }

  const parseInvoice = parseInvoiceAction.bind(null, id);
  const matchInvoice = matchInvoiceAction.bind(null, id);
  const commitInvoice = commitInvoiceAction.bind(null, id);
  const pendingCount = lines.filter((l) => l.status === "pending").length;
  const canCommit = editable && lines.length > 0 && pendingCount === 0 && invoiceImport.status !== "uploaded";

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{invoiceImport.source_filename}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          <span className="uppercase">{invoiceImport.source_format}</span> ·{" "}
          <span className="capitalize">{invoiceImport.status}</span> ·{" "}
          {new Date(invoiceImport.created_at).toLocaleString()}
          {invoiceImport.purchase_order_id ? (
            <>
              {" "}
              ·{" "}
              <Link href={`/inventory/purchase-orders/${invoiceImport.purchase_order_id}`} className="underline">
                view purchase order
              </Link>
            </>
          ) : null}
        </p>
      </div>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {invoiceImport.parse_error ? (
        <p className="text-sm text-[var(--color-error)]">Parse error: {invoiceImport.parse_error}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
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
        {editable && lines.length > 0 ? (
          <form action={matchInvoice}>
            <button
              type="submit"
              className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
            >
              Find matches
            </button>
          </form>
        ) : null}
        {editable && lines.length > 0 ? (
          <form action={commitInvoice}>
            <button
              type="submit"
              disabled={!canCommit}
              className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-40"
              title={canCommit ? undefined : `${pendingCount} line(s) still need review`}
            >
              Commit — create purchase order &amp; receive stock
            </button>
          </form>
        ) : null}
      </div>
      {editable && lines.length > 0 && !canCommit ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {pendingCount > 0
            ? `${pendingCount} line(s) still need to be resolved, ignored, or split before this can be committed.`
            : null}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Matching checks an exact barcode, then this vendor&apos;s own SKU mapping, then a fuzzy
          match against your catalog, then AI for whatever is still unmatched (if configured on
          this server). A suggestion is never applied automatically — resolve each line below, then
          commit to create the purchase order and receive the stock.
        </p>
      ) : null}

      {lines.length > 0 ? (
        <section className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
            Lines
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Raw text</th>
                <th className="px-4 py-2 font-normal">Qty</th>
                <th className="px-4 py-2 font-normal">Unit cost</th>
                <th className="px-4 py-2 font-normal">Suggested match</th>
                <th className="px-4 py-2 font-normal">Review</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <LineRow
                  key={line.id}
                  importId={id}
                  line={line}
                  variants={variants}
                  editable={editable}
                  splitChildCount={lines.filter((l) => l.split_from_line_id === line.id).length}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function LineRow({
  importId,
  line,
  variants,
  editable,
  splitChildCount,
}: {
  importId: string;
  line: InvoiceImportLine;
  variants: VariantOption[];
  editable: boolean;
  splitChildCount: number;
}) {
  const resolveLine = resolveLineAction.bind(null, importId, line.id);
  const ignoreLine = ignoreLineAction.bind(null, importId, line.id);
  const defaultVariantId = line.resolved_variant_id ?? line.ai_suggested_variant_id ?? "";

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="max-w-xs px-4 py-2 text-xs text-[var(--color-text-muted)]">
        {line.split_from_line_id ? (
          <span className="mb-1 block text-[var(--color-accent)]">↳ split from another line</span>
        ) : null}
        {line.raw_text}
      </td>
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
        ) : (line.ai_suggested_brand ?? line.ai_suggested_category ?? line.ai_suggested_product_description) ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            no catalog match — AI suggests:{" "}
            {[line.ai_suggested_brand, line.ai_suggested_category, line.ai_suggested_product_description]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">no match yet</span>
        )}
        {line.is_ambiguous_multi_item ? (
          <span className="mt-1 block text-xs font-medium text-[var(--color-error)]">
            ⚠ looks like more than one item
          </span>
        ) : null}
      </td>
      <td className="min-w-[16rem] px-4 py-2">
        <p className="mb-1 text-xs capitalize">
          {line.status}
          {(line.status === "matched" || line.status === "new_product") && line.resolved_product_name ? (
            <span className="block text-[var(--color-text-muted)]">
              → {line.resolved_product_name}
              {line.resolved_variant_name ? ` — ${line.resolved_variant_name}` : ""}
            </span>
          ) : null}
          {line.status === "split" ? (
            <span className="block text-[var(--color-text-muted)]">into {splitChildCount} line(s)</span>
          ) : null}
        </p>

        {editable && line.status !== "split" ? (
          <div className="flex flex-col gap-2">
            <form action={resolveLine} className="flex flex-col gap-1">
              <select
                name="variant_id"
                defaultValue={defaultVariantId}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">— pick a variant —</option>
                {variants.map((v) => (
                  <option key={v.variant_id} value={v.variant_id}>
                    {v.product_name}
                    {v.variant_name ? ` — ${v.variant_name}` : ""} ({v.sku})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                <input type="checkbox" name="is_new_product" />
                just created this variant for this line
              </label>
              <button
                type="submit"
                className="self-start rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)]"
              >
                Resolve
              </button>
            </form>
            <div className="flex gap-2">
              <form action={ignoreLine}>
                <button type="submit" className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs">
                  Ignore
                </button>
              </form>
              {line.is_ambiguous_multi_item ? (
                <Link
                  href={`/invoice-imports/${importId}/lines/${line.id}/split`}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs"
                >
                  Split into variants
                </Link>
              ) : null}
              {!line.ai_suggested_variant_id ? (
                <Link
                  href={`/catalog/new?${new URLSearchParams({
                    description: line.ai_suggested_product_description ?? line.parsed_description ?? "",
                    brand: line.ai_suggested_brand ?? "",
                    category: line.ai_suggested_category ?? "",
                  })}`}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs"
                >
                  Create new product
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </td>
    </tr>
  );
}
