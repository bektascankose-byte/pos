"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CountSession, type CountedResult } from "./CountSession";
import { catalogRowForSkuAction } from "./actions";
import { archiveVariantAction } from "../catalog/actions";
import { RowEditor } from "../catalog/RowEditor";
import type { SearchRow } from "../catalog/types";
import type { LookupOption } from "../catalog/LookupSelect";
import type { StockLevelRow } from "@snappos/contracts";

export function InventoryClient({
  initialRows,
  categories,
  brands,
  priceGroups,
  storeId,
}: {
  initialRows: StockLevelRow[];
  categories: LookupOption[];
  brands: LookupOption[];
  priceGroups: LookupOption[];
  storeId: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SearchRow | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // Lookup lists are held here for the same reason the catalog list holds
  // them: a category invented inside the editor should appear everywhere at
  // once, without a reload that would abandon a count in progress.
  const [categoryOptions, setCategoryOptions] = useState(categories);
  const [brandOptions, setBrandOptions] = useState(brands);
  const [priceGroupOptions, setPriceGroupOptions] = useState(priceGroups);

  /**
   * A counted item updates its own row in place rather than re-fetching the
   * list. Reloading mid-count would move the focus out of the quantity box,
   * which is the one thing this screen must never do.
   */
  const applyCount = (result: CountedResult) => {
    setRows((prev) =>
      prev.map((row) =>
        row.variant_id === result.variant_id
          ? {
              ...row,
              on_hand: String(result.to),
              available: String(result.to - Number(row.reserved)),
            }
          : row,
      ),
    );
  };

  const openEditor = (row: StockLevelRow) => {
    setMessage(null);
    startTransition(async () => {
      const result = await catalogRowForSkuAction(row.sku);
      if (result.ok) setEditing(result.data);
      else setMessage({ kind: "error", text: result.error });
    });
  };

  const archive = (row: StockLevelRow) => {
    setMessage(null);
    startTransition(async () => {
      const result = await archiveVariantAction(row.variant_id);
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.variant_id !== row.variant_id));
        setMessage({
          kind: "success",
          text: `${row.product_name} archived. Its stock history is kept.`,
        });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const visible = query.trim()
    ? rows.filter((row) =>
        `${row.product_name} ${row.variant_name ?? ""} ${row.sku}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : rows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <Link
          href="/inventory/purchase-orders"
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
        >
          Purchase orders
        </Link>
      </div>

      <CountSession rows={rows} categories={categoryOptions} onCounted={applyCount} />

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      {/* Filters the list already in hand rather than asking the server again:
          the whole stock list is on this page anyway, and a round trip would
          make typing feel slower than scrolling. */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by name or UPC"
        className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">Category</th>
              <th className="px-4 py-2 font-normal">UPC</th>
              <th className="px-4 py-2 text-right font-normal">On hand</th>
              <th className="px-4 py-2 text-right font-normal">Reserved</th>
              <th className="px-4 py-2 text-right font-normal">Available</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.variant_id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/inventory/${row.variant_id}`} className="text-[var(--color-accent)]">
                    {row.product_name}
                    {row.variant_name ? ` — ${row.variant_name}` : ""}
                  </Link>
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">{row.category_name ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">{row.sku}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(row.on_hand)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(row.reserved)}</td>
                <td
                  className={`px-4 py-2 text-right tabular-nums ${
                    Number(row.available) < 0 ? "font-medium text-[var(--color-error)]" : ""
                  }`}
                >
                  {Number(row.available)}
                </td>
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => openEditor(row)}
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => archive(row)}
                      title="Hide from the catalog, the register and search. Stock history is kept, and it can be restored."
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-error)] disabled:opacity-40"
                    >
                      Archive
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  {query ? `No match for "${query}".` : "No active products yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <RowEditor
          row={editing}
          categories={categoryOptions}
          brands={brandOptions}
          priceGroups={priceGroupOptions}
          onCategoryCreated={(option) => setCategoryOptions((prev) => [...prev, option])}
          onBrandCreated={(option) => setBrandOptions((prev) => [...prev, option])}
          onPriceGroupCreated={(option) => setPriceGroupOptions((prev) => [...prev, option])}
          storeLabel={storeId ? "this store" : "all stores"}
          onStockChanged={() => router.refresh()}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMessage({ kind: "success", text: "Saved." });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
