"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ShopCartLine } from "@snappos/contracts";
import { setQuantityAction } from "@/app/cart/actions";
import { money, productHref } from "@/lib/format";
import { ProductImage } from "./ProductCard";

export function CartLine({ line }: { line: ShopCartLine }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const name = line.variant_name ? `${line.product_name}, ${line.variant_name}` : line.product_name;

  const change = (quantity: number) => {
    setError(null);
    startTransition(async () => {
      const result = await setQuantityAction(line.variant_id, quantity);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  return (
    <li className="flex gap-4 py-4">
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-sunk)] p-2">
        <ProductImage imageId={line.image_id} name={line.product_name} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <Link href={productHref(line.product_id, line.product_name)} className="font-semibold underline-offset-2 hover:underline">
            {name}
          </Link>
          <span className="tabular font-semibold">{line.line_total_minor ? money(line.line_total_minor) : "—"}</span>
        </div>
        {line.unit_price_minor ? (
          <p className="tabular text-sm text-[var(--muted)]">{money(line.unit_price_minor)} each</p>
        ) : null}

        {line.problem_message ? (
          <p role="alert" className="text-sm font-medium text-[var(--danger)]">
            {line.problem_message}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center gap-3">
          <div className="flex items-center rounded-full border border-[var(--line)] bg-[var(--surface)]">
            <button
              type="button"
              className="h-11 w-11 rounded-full text-lg disabled:opacity-40"
              onClick={() => change(line.quantity - 1)}
              disabled={pending || line.quantity <= 1}
              aria-label={`One fewer ${name}`}
            >
              −
            </button>
            <span className="tabular w-10 text-center" aria-label={`Quantity of ${name}`}>
              {line.quantity}
            </span>
            <button
              type="button"
              className="h-11 w-11 rounded-full text-lg disabled:opacity-40"
              onClick={() => change(line.quantity + 1)}
              disabled={pending || line.quantity >= line.max_quantity}
              aria-label={`One more ${name}`}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="min-h-[44px] text-sm text-[var(--muted)] underline underline-offset-2 disabled:opacity-40"
            onClick={() => change(0)}
            disabled={pending}
          >
            Remove
          </button>
          {error ? (
            <span role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
