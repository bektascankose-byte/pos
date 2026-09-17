"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ShopVariant } from "@snappos/contracts";
import { addToCartAction } from "@/app/cart/actions";
import { money } from "@/lib/format";
import { StockLabel } from "./ProductCard";

/**
 * Choose a flavour, a quantity, and add it.
 *
 * Flavours are a radio group, not a dropdown, so every option and its stock is
 * visible at once and operable by keyboard. An option with none left stays in
 * the list, disabled and labelled, rather than disappearing -- "Watermelon Ice:
 * out of stock" answers the question a missing option would only raise.
 */
export function AddToCart({ variants }: { variants: ShopVariant[] }) {
  const firstAvailable = variants.find((v) => v.stock !== "out_of_stock") ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstAvailable?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "added" | "error"; text: string } | null>(null);

  const selected = variants.find((v) => v.id === selectedId);
  const limit = Math.min(selected?.max_per_order ?? 99, 99);
  const unavailable = !selected || selected.stock === "out_of_stock";

  return (
    <div className="flex flex-col gap-5">
      {variants.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">Choose an option</legend>
          {variants.map((variant) => {
            const out = variant.stock === "out_of_stock";
            return (
              <label
                key={variant.id}
                htmlFor={`variant-${variant.id}`}
                className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 ${
                  variant.id === selectedId ? "border-[var(--ink)] bg-[var(--surface-sunk)]" : "border-[var(--line)]"
                } ${out ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  id={`variant-${variant.id}`}
                  type="radio"
                  name="variant"
                  value={variant.id}
                  checked={variant.id === selectedId}
                  disabled={out}
                  onChange={() => {
                    setSelectedId(variant.id);
                    // Five of one flavour can be too many of one with a limit.
                    setQuantity((q) => Math.min(q, variant.max_per_order ?? 99, 99));
                    setStatus(null);
                  }}
                  className="h-5 w-5"
                />
                <span className="flex-1">{variant.name ?? "Standard"}</span>
                <span className="tabular text-sm">{money(variant.price_minor)}</span>
                <StockLabel stock={variant.stock} />
              </label>
            );
          })}
        </fieldset>
      ) : selected ? (
        <div className="flex items-center gap-4">
          <span className="tabular text-2xl font-semibold">{money(selected.price_minor)}</span>
          <StockLabel stock={selected.stock} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="quantity" className="text-sm font-semibold">
            Quantity
          </label>
          <div className="flex items-center rounded-full border border-[var(--line)] bg-[var(--surface)]">
            <button
              type="button"
              className="h-11 w-11 rounded-full text-lg disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.max(q - 1, 1))}
              disabled={quantity <= 1}
              aria-label="One fewer"
            >
              −
            </button>
            <input
              id="quantity"
              inputMode="numeric"
              className="tabular h-11 w-12 bg-transparent text-center"
              value={quantity}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
                setQuantity(Number.isFinite(next) ? Math.min(Math.max(next, 1), limit) : 1);
              }}
            />
            <button
              type="button"
              className="h-11 w-11 rounded-full text-lg disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.min(q + 1, limit))}
              disabled={quantity >= limit}
              aria-label="One more"
            >
              +
            </button>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary flex-1 sm:flex-none sm:px-8"
          disabled={pending || unavailable}
          onClick={() => {
            if (!selected) return;
            setStatus(null);
            startTransition(async () => {
              const result = await addToCartAction(selected.id, quantity);
              if (result.ok) {
                setStatus({ kind: "added", text: `Added. Your cart has ${result.cart.item_count} item${result.cart.item_count === 1 ? "" : "s"}.` });
                setQuantity(1);
              } else {
                setStatus({ kind: "error", text: result.error });
              }
            });
          }}
        >
          {unavailable ? "Out of stock" : pending ? "Adding…" : "Add to cart"}
        </button>
      </div>

      {selected?.max_per_order ? (
        <p className="text-sm text-[var(--muted)]">Limit {selected.max_per_order} per order.</p>
      ) : null}

      <div aria-live="polite" className="min-h-[1.5rem]">
        {status ? (
          <p className={`text-sm ${status.kind === "error" ? "text-[var(--danger)]" : "text-[var(--ok)]"}`}>
            {status.text}{" "}
            {status.kind === "added" ? (
              <Link href="/cart" className="font-semibold underline underline-offset-2">
                View cart
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
