"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import {
  setPriceCategoryPriceAction,
  removePriceCategoryMemberAction,
  scanAddToPriceCategoryAction,
  renamePriceCategoryAction,
  addMembersToPriceGroupAction,
} from "../../actions";
import type { SearchRow } from "../../types";
import type { PriceCategory, PriceCategoryMember } from "@snappos/contracts";

// `current_price_minor`/`price_minor` type as the branded `Money` in the
// shared schema (it's shared with request validation), but what actually
// crosses the wire -- and what this component stores back into state after
// an optimistic update -- is the plain digit string the API sends. See the
// same `String()` boundary-bridging elsewhere (catalog/[id]/page.tsx).
type GroupRef = { id: string; name: string | null };
type Member = Omit<PriceCategoryMember, "price_minor" | "price_since" | "also_in"> & {
  price_minor: string | null;
  /** When the current price was set, by whatever route. */
  price_since: string | null;
  /** The other groups this item is in. */
  also_in: GroupRef[];
};
export type CategoryWithMembers = Omit<PriceCategory, "current_price_minor" | "common_price_minor" | "mismatch_count"> & {
  current_price_minor: string | null;
  members: Member[];
};

/** Members read A to Z, the way the list shows them after a reload. */
function byName(a: Member, b: Member): number {
  return (
    a.product_name.localeCompare(b.product_name, undefined, { sensitivity: "base" }) ||
    (a.variant_name ?? "").localeCompare(b.variant_name ?? "", undefined, { sensitivity: "base" }) ||
    a.sku.localeCompare(b.sku)
  );
}

/** "Sep 30, 2026". Rendered only in the browser's own time zone, so the server's guess is not trusted. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function PriceCategoryClient({
  categoryId,
  initialCategory,
  storeId,
}: {
  categoryId: string;
  initialCategory: CategoryWithMembers;
  storeId: string | null;
}) {
  const [category, setCategory] = useState(initialCategory);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string; sendLink?: boolean } | null>(
    null,
  );
  const [pricePending, startPriceTransition] = useTransition();

  // Renaming is inline rather than a dialog: it's one field on the thing
  // already being looked at, and groups made by "Price selected together"
  // arrive unnamed, so giving one a name is often the first thing done here.
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

  const [findQuery, setFindQuery] = useState("");
  const [found, setFound] = useState<SearchRow[] | null>(null);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [findPending, startFindTransition] = useTransition();

  const isMember = (variantId: string) => category.members.some((m) => m.variant_id === variantId);

  const addMember = (member: Member) =>
    setCategory((prev) =>
      prev.members.some((existing) => existing.variant_id === member.variant_id)
        ? prev
        : {
            ...prev,
            current_price_minor: null,
            member_count: prev.member_count + 1,
            members: [...prev.members, member].sort(byName),
          },
    );

  const handleSetPrice = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    const form = e.currentTarget;
    startPriceTransition(async () => {
      const result = await setPriceCategoryPriceAction(categoryId, formData);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      // Every member takes on this same new price, set just now -- no need to
      // re-fetch to know that; parsed the same way the server just validated it.
      const priceMinor = parseMajorToMinor(String(formData.get("price") ?? ""));
      const now = new Date().toISOString();
      setCategory((prev) => ({
        ...prev,
        current_price_minor: priceMinor,
        members: prev.members.map((m) => ({ ...m, price_minor: priceMinor, price_since: now })),
      }));
      form.reset();
      setMessage({
        kind: "success",
        text: `Saved. ${category.members.length} item${category.members.length === 1 ? "" : "s"} repriced.`,
        sendLink: true,
      });
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
        const label = `${m.product_name}${m.variant_name ? `, ${m.variant_name}` : ""} (${m.sku})`;
        if (m.already_member) {
          setScanStatus(`Already in this group: ${m.sku}`);
        } else {
          setScanCount((n) => n + 1);
          setScanLog((prev) => [label, ...prev]);
          setScanStatus(`Added: ${m.sku}`);
          addMember({
            variant_id: m.variant_id,
            product_id: m.product_id,
            product_name: m.product_name,
            variant_name: m.variant_name,
            sku: m.sku,
            price_minor: m.price_minor,
            price_since: null,
            also_in: [],
          } as Member);
        }
      }
      if (scanInputRef.current) {
        scanInputRef.current.value = "";
        scanInputRef.current.focus();
      }
    });
  };

  /**
   * Finding an item by what it's called, for the promotion that mixes items
   * from different products and the flavor not in hand to scan. Uses the same
   * search the catalog list does.
   */
  const handleFind = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = findQuery.trim();
    if (!q) return;
    setFindStatus(null);
    startFindTransition(async () => {
      const params = new URLSearchParams({ q });
      if (storeId) params.set("store_id", storeId);
      try {
        const res = await fetch(`/api/catalog/search?${params}`);
        const body = (await res.json()) as { data?: SearchRow[]; error?: string };
        if (!res.ok) {
          setFindStatus(body.error ?? "Could not search the catalog.");
          return;
        }
        const rows = body.data ?? [];
        setFound(rows);
        if (rows.length === 0) setFindStatus("Nothing matches that.");
      } catch {
        setFindStatus("Could not search the catalog.");
      }
    });
  };

  const addFound = (row: SearchRow) => {
    setFindStatus(null);
    startFindTransition(async () => {
      const result = await addMembersToPriceGroupAction(categoryId, [row.variant_id]);
      if (!result.ok) {
        setFindStatus(result.error);
        return;
      }
      addMember({
        variant_id: row.variant_id,
        product_id: row.product_id,
        product_name: row.product_name,
        variant_name: row.variant_name,
        sku: row.sku,
        price_minor: row.price_minor,
        price_since: null,
        also_in: row.price_groups.filter((g) => g.id !== categoryId),
      } as Member);
      setFindStatus(`Added: ${row.product_name}${row.variant_name ? `, ${row.variant_name}` : ""}`);
    });
  };

  const handleRemove = (variantId: string) => {
    setMessage(null);
    startPriceTransition(async () => {
      const result = await removePriceCategoryMemberAction(categoryId, variantId);
      if (result.ok) {
        setCategory((prev) => {
          const members = prev.members.filter((m) => m.variant_id !== variantId);
          const prices = members.map((m) => m.price_minor);
          const uniform = prices.length > 0 && prices.every((p) => p !== null && p === prices[0]);
          return {
            ...prev,
            member_count: members.length,
            members,
            current_price_minor: uniform ? prices[0]! : null,
          };
        });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  // The item this group was made for, when an AI draft made it. Named from
  // its own members rather than a second request.
  const madeFor = category.product_id
    ? category.members.find((m) => m.product_id === category.product_id)
    : undefined;

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
          {madeFor ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Every flavor of{" "}
              <Link href={`/catalog/${madeFor.product_id}`} className="text-[var(--color-accent)]">
                {madeFor.product_name}
              </Link>
              . Flavors added to it later join this group on their own.
            </p>
          ) : null}
        </div>
        <Link href="/catalog/price-categories" className="text-sm text-[var(--color-accent)]">
          ← All price groups
        </Link>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
          {message.sendLink ? (
            <>
              {" "}
              The new price reaches the registers when you{" "}
              <Link href="/catalog/send-to-pos" className="text-[var(--color-accent)]">
                Send to POS
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <form
          onSubmit={handleSetPrice}
          className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Set price for this group
              <input
                name="price"
                placeholder="9.99"
                className="w-28 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <button
              type="submit"
              disabled={pricePending || category.members.length === 0}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
            >
              {pricePending ? "Applying..." : "Apply to every member"}
            </button>
          </div>
          <p className="max-w-xs text-xs text-[var(--color-text-muted)]">
            Only the items in this group change. An item also in another group takes this price too, since the
            last price set is the one that counts.
          </p>
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
            Each scan is added right away, nothing to &quot;complete.&quot; Remove a mis-scan from the table below.
          </p>
        </div>

        <div className="flex min-w-[280px] flex-1 flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <span className="text-sm font-medium">Find by name</span>
          <form onSubmit={handleFind} className="flex items-end gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Item, flavor or brand
              <input
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                placeholder="Monster Ultra"
                autoComplete="off"
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <button
              type="submit"
              disabled={findPending}
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
            >
              Search
            </button>
          </form>
          {findStatus ? <p className="text-xs text-[var(--color-text-muted)]">{findStatus}</p> : null}
          {found && found.length > 0 ? (
            <ul className="flex max-h-64 flex-col overflow-y-auto text-sm">
              {found.slice(0, 30).map((row) => (
                <li
                  key={row.variant_id}
                  className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] py-1.5"
                >
                  <span className="min-w-0 truncate">
                    {row.product_name}
                    {row.variant_name ? `, ${row.variant_name}` : ""}
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      {row.price_minor !== null ? formatMinor(row.price_minor) : "no price"}
                    </span>
                  </span>
                  {isMember(row.variant_id) ? (
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">In this group</span>
                  ) : (
                    <button
                      type="button"
                      disabled={findPending}
                      onClick={() => addFound(row)}
                      className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-60"
                    >
                      Add
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        You can also add items from the{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          catalog list
        </Link>
        &apos;s checkboxes. An item can be in more than one group. Its price is the last one set, from here,
        another group or its own page.
      </p>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">UPC</th>
              <th className="px-4 py-2 font-normal">Price</th>
              <th className="px-4 py-2 font-normal">Also in</th>
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
                <td className="px-4 py-2 tabular-nums">
                  {m.price_minor !== null ? formatMinor(String(m.price_minor)) : "—"}
                  {m.price_since ? (
                    <span className="block text-xs text-[var(--color-text-muted)]" suppressHydrationWarning>
                      set {shortDate(m.price_since)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  {m.also_in.length === 0 ? (
                    <span className="text-[var(--color-text-muted)]">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-2">
                      {m.also_in.map((g) => (
                        <Link key={g.id} href={`/catalog/price-categories/${g.id}`} className="text-[var(--color-accent)]">
                          {g.name ?? "Unnamed group"}
                        </Link>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => handleRemove(m.variant_id)} className="text-[var(--color-error)]">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {category.members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
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
