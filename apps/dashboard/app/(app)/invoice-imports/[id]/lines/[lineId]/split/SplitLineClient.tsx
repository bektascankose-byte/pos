"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { splitLineAction } from "../../../../actions";
import type { InvoiceImportLine } from "@snappos/contracts";

interface VariantOption {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_name: string;
}

const INITIAL_ROWS = 2;

export function SplitLineClient({
  importId,
  line,
  variants,
}: {
  importId: string;
  line: InvoiceImportLine;
  variants: VariantOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(INITIAL_ROWS);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await splitLineAction(importId, line.id, formData, rowCount);
      if (result.ok) {
        router.push(`/invoice-imports/${importId}?saved=1`);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link href={`/invoice-imports/${importId}`} className="text-sm underline">
          ← back to invoice
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Split this line into variants</h1>
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="text-[var(--color-text-muted)]">Original line</p>
        <p className="mt-1">{line.raw_text}</p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Quantity {line.parsed_quantity ?? "—"} · Unit cost {line.parsed_unit_cost ?? "—"}
          {line.ai_suggested_brand || line.ai_suggested_category || line.ai_suggested_product_description ? (
            <>
              {" "}
              · AI suggests:{" "}
              {[line.ai_suggested_brand, line.ai_suggested_category, line.ai_suggested_product_description]
                .filter(Boolean)
                .join(" · ")}
            </>
          ) : null}
        </p>
      </section>

      <p className="text-xs text-[var(--color-text-muted)]">
        Each row becomes its own new line, resolved to the variant you pick. The variant has to
        already exist in the catalog first — if it doesn&apos;t yet, open the product in{" "}
        <Link href="/catalog" className="underline">
          Catalog
        </Link>{" "}
        and use its &quot;Add variant&quot; form, then come back here. The quantities below must add
        up to the original line&apos;s quantity ({line.parsed_quantity ?? "—"}).
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <div className="grid grid-cols-[1fr_100px_100px] gap-2 text-xs text-[var(--color-text-muted)]">
          <span>Variant</span>
          <span>Quantity</span>
          <span>Unit cost</span>
        </div>
        {Array.from({ length: rowCount }, (_, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_100px] gap-2">
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
              placeholder={line.parsed_unit_cost ?? "cost"}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRowCount((n) => n + 1)}
          className="self-start text-xs text-[var(--color-accent)] underline"
        >
          + Add another row
        </button>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Splitting..." : "Split this line"}
        </button>
      </form>
    </div>
  );
}
