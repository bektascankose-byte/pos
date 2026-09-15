"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import {
  renamePriceCategoryAction,
  deletePriceCategoryAction,
  setPriceCategoryPriceAction,
} from "../actions";
import { Modal } from "../../_components/Modal";
import type { PriceCategory } from "@snappos/contracts";

/**
 * `current_price_minor` types as the branded `Money` because it shares
 * `priceCategorySchema` with request validation, but this response was never
 * parsed through that schema — it's the plain digit string the API sends.
 * `String()` bridges that at the boundary.
 */
function groupPrice(category: PriceCategory): string | null {
  return category.current_price_minor === null ? null : String(category.current_price_minor);
}

export function PriceCategoriesClient({ categories }: { categories: PriceCategory[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<PriceCategory | null>(null);
  const [confirming, setConfirming] = useState<PriceCategory | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = (category: PriceCategory) => {
    setMessage(null);
    startTransition(async () => {
      const result = await deletePriceCategoryAction(category.id);
      setConfirming(null);
      if (result.ok) {
        setMessage({
          kind: "success",
          text:
            result.data.released > 0
              ? `Group deleted. ${result.data.released} item${result.data.released === 1 ? "" : "s"} released — their prices are unchanged.`
              : "Group deleted.",
        });
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Price groups</h1>
        <Link
          href="/catalog/price-categories/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          New group
        </Link>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Group items so their price can be changed all at once later. Add members from the{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          catalog list
        </Link>{" "}
        or by scanning them on a group&apos;s own page.
      </p>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 text-right font-normal">Members</th>
              <th className="px-4 py-2 text-right font-normal">Price</th>
              <th className="px-4 py-2 font-normal">Off the group price</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link
                    href={`/catalog/price-categories/${category.id}`}
                    className="text-[var(--color-accent)]"
                  >
                    {category.name ?? "(unnamed)"}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{category.member_count}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {groupPrice(category) !== null ? formatMinor(groupPrice(category)!) : "mixed / —"}
                </td>
                <td className="px-4 py-2">
                  {category.mismatch_count > 0 ? (
                    <Link
                      href={`/catalog/price-categories/${category.id}`}
                      className="font-medium text-[var(--color-error)]"
                    >
                      {category.mismatch_count} item{category.mismatch_count === 1 ? "" : "s"}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(category)}
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirming(category)}
                      title="Ungroup these items. Nothing is removed from the catalog."
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-error)] disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {categories.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No price groups yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <EditGroupModal
          category={editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage({ kind: "success", text });
            router.refresh();
          }}
        />
      ) : null}

      {confirming ? (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={`Delete ${confirming.name ?? "this group"}?`}
          description="Only the group goes. Every item in it stays in the catalog at the price it has now."
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--color-text-muted)]">
              {confirming.member_count === 0
                ? "It has no members."
                : `${confirming.member_count} item${confirming.member_count === 1 ? "" : "s"} will be ungrouped. Nothing is archived, no price changes, and you can group them again later.`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => remove(confirming)}
                className="rounded-md bg-[var(--color-error)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {pending ? "Deleting..." : "Delete group"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Renaming and repricing in one dialog, but two separate calls underneath —
 * they are genuinely different acts. Renaming relabels a folder; repricing
 * changes what every member costs at the counter, which is why the price
 * field says how many items it will move and is left blank by default on a
 * group whose members don't currently agree.
 */
function EditGroupModal({
  category,
  onClose,
  onSaved,
}: {
  category: PriceCategory;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const current = groupPrice(category);
  const [name, setName] = useState(category.name ?? "");
  const [price, setPrice] = useState(current !== null ? minorToMajor(current) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const priceChanged = price.trim() !== "" && parseMajorToMinor(price.trim()) !== current;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const done: string[] = [];

      if (name.trim() && name.trim() !== (category.name ?? "")) {
        const renamed = await renamePriceCategoryAction(category.id, name);
        if (!renamed.ok) {
          setError(renamed.error);
          return;
        }
        done.push("Renamed");
      }

      if (priceChanged) {
        const formData = new FormData();
        formData.set("price", price.trim());
        const repriced = await setPriceCategoryPriceAction(category.id, formData);
        if (!repriced.ok) {
          setError(repriced.error);
          return;
        }
        done.push(
          `${category.member_count} item${category.member_count === 1 ? "" : "s"} repriced`,
        );
      }

      onSaved(done.length > 0 ? `${done.join(", ")}.` : "Nothing changed.");
    });
  };

  return (
    <Modal open onClose={onClose} title="Edit price group">
      <div className="flex flex-col gap-3">
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="$24.99 vapes"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Group price ($)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={current === null ? "members are priced differently" : "24.99"}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {priceChanged
              ? `Saving will reprice all ${category.member_count} item${category.member_count === 1 ? "" : "s"} in this group, and each change is recorded in that item's price history.`
              : "Change this to reprice every item in the group at once."}
          </span>
        </label>

        <div className="mt-1 flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={save}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function minorToMajor(minor: string): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
