"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor, minorToMajor } from "@/lib/money";
import { Modal } from "../../_components/Modal";
import { searchReferenceAction, promoteReferenceAction } from "./actions";
import type { Brand, Category, ReferenceSearchRow, ReferenceSourceStats } from "@snappos/contracts";

export function ReferenceClient({
  stats,
  brands,
  categories,
  storeId,
}: {
  stats: ReferenceSourceStats[];
  brands: Brand[];
  categories: Category[];
  storeId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ReferenceSearchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<ReferenceSearchRow | null>(null);
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const total = stats.reduce((sum, s) => sum + s.total, 0);

  const run = (value: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await searchReferenceAction(value);
      if (outcome.ok) setRows(outcome.data);
      else setError(outcome.error);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-medium">Known products</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
          {total > 0 ? (
            <>
              {total.toLocaleString()} products carried over from your old system. These are{" "}
              <strong className="font-medium text-[var(--color-text)]">not in your inventory</strong> — they
              don&apos;t sell, count or report. Scanning one anywhere in the back office shows you what it
              is, and adding it here is what puts it in your catalog.
            </>
          ) : (
            <>
              Nothing here yet. A reference file is your old system&apos;s full item list, kept so that
              scanning an unfamiliar barcode can still tell you what it is.
            </>
          )}
        </p>
      </header>

      {stats.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {stats.map((source) => (
            <div
              key={source.source}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
            >
              <div className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                {source.source}
              </div>
              <div className="mt-1 text-sm">
                {source.total.toLocaleString()} products
                <span className="block text-xs text-[var(--color-text-muted)]">
                  {source.with_stock.toLocaleString()} had stock there when exported
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Handled explicitly rather than left to the form's implicit
          // submission, the same way Item Lookup does it: a scanner ends its
          // code with a keystroke, and searching shouldn't depend on which
          // key that scanner happens to be configured to send.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run(query);
            }
          }}
          placeholder="Scan a code, or search by name"
          className="w-96 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Searching..." : "Search"}
        </button>
      </form>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      {added ? (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
          Added <strong className="font-medium">{added.name}</strong> to your catalog.{" "}
          <Link href={`/catalog/${added.id}`} className="text-[var(--color-accent)] underline">
            Open it
          </Link>{" "}
          <span className="text-[var(--color-text-muted)]">
            — it has no stock until you receive or count some.
          </span>
        </p>
      ) : null}

      {rows !== null ? (
        rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nothing known by that code or name.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Department</th>
                  <th className="px-4 py-2 text-right font-medium">Retail</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                  <th className="px-4 py-2 text-right font-medium">Was on hand</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2">{row.description ?? <em>no name</em>}</td>
                    <td className="px-4 py-2 font-mono text-xs">{row.scan_code}</td>
                    <td className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
                      {row.department ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {row.retail_minor ? formatMinor(String(row.retail_minor)) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-[var(--color-text-muted)]">
                      {row.cost ? `$${trimCost(row.cost)}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-[var(--color-text-muted)]">
                      {row.source_quantity ? Number(row.source_quantity).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {row.stocked_variant_id ? (
                        <span className="text-xs text-[var(--color-text-muted)]">In your catalog</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setAdded(null);
                            setPromoting(row);
                          }}
                          className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-bg)]"
                        >
                          Add to catalog
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      <PromoteModal
        row={promoting}
        brands={brands}
        categories={categories}
        storeId={storeId}
        onClose={() => setPromoting(null)}
        onAdded={(id, name) => {
          setPromoting(null);
          setAdded({ id, name });
          // Re-run the search so the row disappears from what is, by
          // definition, a list of things not in the catalog.
          run(query);
        }}
      />
    </div>
  );
}

function PromoteModal({
  row,
  brands,
  categories,
  storeId,
  onClose,
  onAdded,
}: {
  row: ReferenceSearchRow | null;
  brands: Brand[];
  categories: Category[];
  storeId: string | null;
  onClose: () => void;
  onAdded: (productId: string, name: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!row) return null;

  // Only an exact department-name match pre-selects a category. A near miss
  // filing an item under the wrong one is worse than leaving it blank.
  const matchedCategory = row.department
    ? categories.find((c) => c.name.toLowerCase() === row.department!.toLowerCase())
    : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add to your catalog"
      description={`Creates a real item from what your old system knew about ${row.scan_code}. It starts with no stock.`}
    >
      {error ? <p className="mb-3 text-xs text-[var(--color-error)]">{error}</p> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const outcome = await promoteReferenceAction(row.id, storeId, formData);
            if (outcome.ok) onAdded(outcome.data.product_id, outcome.data.name);
            else setError(outcome.error);
          });
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Name
          <input
            name="name"
            required
            defaultValue={row.description ?? ""}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        <div className="flex gap-3">
          <label className="flex w-28 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Price
            <input
              name="price"
              placeholder="9.99"
              defaultValue={row.retail_minor ? minorToMajor(String(row.retail_minor)) : ""}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex w-28 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Cost
            <input
              name="cost"
              placeholder="0"
              defaultValue={row.cost ? trimCost(row.cost) : ""}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
        </div>

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Category
            <select
              name="category_id"
              defaultValue={matchedCategory?.id ?? ""}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {row.department ? (
              <span className="text-[0.7rem]">
                {matchedCategory
                  ? `Matched "${row.department}" from your old system.`
                  : `Was "${row.department}" — no category here by that name.`}
              </span>
            ) : null}
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Brand
            <select
              name="brand_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">None</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          The code <span className="font-mono">{row.scan_code}</span> becomes its UPC
          {row.units_per_case && row.units_per_case > 1 ? `, with ${row.units_per_case} to a case` : ""}.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Adding..." : "Add to catalog"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Cost is `numeric(14,6)`, so "3.500000" needs its trailing zeroes trimmed as text. */
function trimCost(cost: string): string {
  return cost.includes(".") ? cost.replace(/0+$/, "").replace(/\.$/, "") : cost;
}
