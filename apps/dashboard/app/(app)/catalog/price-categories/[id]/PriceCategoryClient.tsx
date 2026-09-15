"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import {
  setPriceCategoryPriceAction,
  removePriceCategoryMemberAction,
  scanAddToPriceCategoryAction,
  renamePriceCategoryAction,
} from "../../actions";
import type { PriceCategory, PriceCategoryMember } from "@snappos/contracts";

// `current_price_minor`/`price_minor` type as the branded `Money` in the
// shared schema (it's shared with request validation), but what actually
// crosses the wire -- and what this component stores back into state after
// an optimistic update -- is the plain digit string the API sends. See the
// same `String()` boundary-bridging elsewhere (catalog/[id]/page.tsx).
type Member = Omit<PriceCategoryMember, "price_minor"> & { price_minor: string | null };
export type CategoryWithMembers = Omit<PriceCategory, "current_price_minor"> & {
  current_price_minor: string | null;
  members: Member[];
};

export function PriceCategoryClient({
  categoryId,
  initialCategory,
}: {
  categoryId: string;
  initialCategory: CategoryWithMembers;
}) {
  const [category, setCategory] = useState(initialCategory);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pricePending, startPriceTransition] = useTransition();

  // Renaming is inline rather than a dialog: it's one field on the thing
  // already being looked at, and most of these groups arrive unnamed (they're
  // formed implicitly by "Price selected together"), so giving one a name is
  // the first thing anyone does here.
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initialCategory.name ?? "");
  const [renamePending, startRenameTransition] = useTransition();

  const rename = () => {
    setMessage(null);
    startRenameTransition(async () => {
      const result = await renamePriceCategoryAction(categoryId, name);
      if (result.ok) {
        setCategory((prev) => ({ ...prev, name: name.trim() }));
        setRenaming(false);
        setMessage({ kind: "success", text: "Renamed." });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [scanPending, startScanTransition] = useTransition();
  const scanInputRef = useRef<HTMLInputElement>(null);

  const handleSetPrice = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    startPriceTransition(async () => {
      const result = await setPriceCategoryPriceAction(categoryId, formData);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      // Every member takes on this same new price -- no need to re-fetch to
      // know that; parsed the same way the server just validated it.
      const priceMinor = parseMajorToMinor(String(formData.get("price") ?? ""));
      setCategory((prev) => ({
        ...prev,
        current_price_minor: priceMinor,
        members: prev.members.map((m) => ({ ...m, price_minor: priceMinor })),
      }));
      setMessage({ kind: "success", text: "Saved." });
    });
  };

  const handleScan = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = scanInputRef.current?.value.trim() ?? "";
    if (!code) return;
    setScanStatus("Adding...");
    startScanTransition(async () => {
      const result = await scanAddToPriceCategoryAction(categoryId, code);
      if (!result.ok) {
        setScanStatus(result.error);
      } else {
        const m = result.data;
        setScanCount((n) => n + 1);
        setScanLog((prev) => [`${m.product_name}${m.variant_name ? ` — ${m.variant_name}` : ""} (${m.sku})`, ...prev]);
        setScanStatus(`Added: ${m.sku}`);
        setCategory((prev) =>
          prev.members.some((existing) => existing.variant_id === m.variant_id)
            ? prev
            : {
                ...prev,
                member_count: prev.member_count + 1,
                members: [
                  ...prev.members,
                  { variant_id: m.variant_id, product_id: "", product_name: m.product_name, variant_name: m.variant_name, sku: m.sku, price_minor: null },
                ],
              },
        );
      }
      if (scanInputRef.current) {
        scanInputRef.current.value = "";
        scanInputRef.current.focus();
      }
    });
  };

  const handleRemove = (variantId: string) => {
    setMessage(null);
    startPriceTransition(async () => {
      const result = await removePriceCategoryMemberAction(categoryId, variantId);
      if (result.ok) {
        setCategory((prev) => ({
          ...prev,
          member_count: prev.member_count - 1,
          members: prev.members.filter((m) => m.variant_id !== variantId),
        }));
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                rename();
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-lg font-semibold outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="submit"
                disabled={renamePending}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
              >
                {renamePending ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setName(category.name ?? "");
                  setRenaming(false);
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{category.name ?? "(unnamed)"}</h1>
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Rename
              </button>
            </div>
          )}
          <p className="text-sm text-[var(--color-text-muted)]">
            {category.member_count} member{category.member_count === 1 ? "" : "s"} ·{" "}
            {category.current_price_minor !== null
              ? formatMinor(String(category.current_price_minor))
              : category.member_count === 0
                ? "no members yet"
                : "mixed price"}
          </p>
        </div>
        <Link href="/catalog/price-categories" className="text-sm text-[var(--color-accent)]">
          ← All price groups
        </Link>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <form
          onSubmit={handleSetPrice}
          className="flex items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <label className="flex flex-col gap-1 text-sm">
            Set price for this category
            <input
              name="price"
              placeholder="9.99"
              className="w-28 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            disabled={pricePending}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pricePending ? "Applying..." : "Apply to every member"}
          </button>
        </form>

        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <span className="text-sm font-medium">Speed-scan add</span>
          <form onSubmit={handleScan} className="flex items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Scan or type a UPC
              <input
                ref={scanInputRef}
                name="code"
                autoFocus
                autoComplete="off"
                className="w-48 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <button
              type="submit"
              disabled={scanPending}
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
            >
              Add
            </button>
          </form>
          {scanStatus ? <p className="text-xs text-[var(--color-text-muted)]">{scanStatus}</p> : null}
          {scanCount > 0 ? <p className="text-xs text-[var(--color-text-muted)]">{scanCount} added this session</p> : null}
          <ul className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            {scanLog.map((entry, i) => (
              <li key={i}>{entry}</li>
            ))}
          </ul>
          <p className="text-xs text-[var(--color-text-muted)]">
            Each scan is added right away — nothing to &quot;complete.&quot; Remove a mis-scan from the
            table below.
          </p>
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Add more members the traditional way from the{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          catalog list
        </Link>
        &apos;s checkboxes. Adding an item here moves it out of any other price category it was in.
      </p>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">UPC</th>
              <th className="px-4 py-2 font-normal">Price</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {category.members.map((m) => (
              <tr key={m.variant_id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  {m.product_id ? (
                    <Link href={`/catalog/${m.product_id}`} className="text-[var(--color-accent)]">
                      {m.product_name}
                      {m.variant_name ? ` — ${m.variant_name}` : ""}
                    </Link>
                  ) : (
                    <>
                      {m.product_name}
                      {m.variant_name ? ` — ${m.variant_name}` : ""}
                    </>
                  )}
                </td>
                <td className="px-4 py-2">{m.sku}</td>
                <td className="px-4 py-2">{m.price_minor !== null ? formatMinor(String(m.price_minor)) : "—"}</td>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => handleRemove(m.variant_id)} className="text-[var(--color-error)]">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {category.members.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No members yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
