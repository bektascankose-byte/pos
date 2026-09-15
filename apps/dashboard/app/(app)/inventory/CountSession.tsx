"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setCountedStockAction } from "../catalog/actions";
import { resolveCodeAction } from "./actions";
import type { StockLevelRow } from "@snappos/contracts";

export interface CountedResult {
  variant_id: string;
  label: string;
  from: number;
  to: number;
  delta: number;
}

type Mode = "category" | "scan";

/**
 * Counting stock, at the speed someone actually counts.
 *
 * The whole design goal is that a person holding a clipboard (or a scanner)
 * never touches the mouse: the app names one item, they type what they
 * counted, press Enter, and the app moves to the next one. Two ways in, and
 * they suit different jobs:
 *
 * - **By category** walks a shelf in catalog order. One Enter per item.
 * - **By scan** follows whatever is picked up next. The scanner types the
 *   code and its own Enter, focus lands on the quantity, and a second Enter
 *   files it and returns to waiting for the next scan.
 *
 * Nothing is "submitted" at the end: each Enter posts its own count
 * immediately, because a counting session interrupted by a customer at the
 * till should not lose the last twenty minutes of work. That does mean the
 * ledger gets one `count_adjustment` per item that moved, which is exactly
 * what it is for.
 */
export function CountSession({
  rows,
  categories,
  onCounted,
}: {
  rows: StockLevelRow[];
  categories: { id: string; name: string }[];
  /** Lets the page update its own table as counts land. */
  onCounted: (result: CountedResult) => void;
}) {
  const [mode, setMode] = useState<Mode>("category");
  const [categoryId, setCategoryId] = useState("");
  const [queue, setQueue] = useState<StockLevelRow[]>([]);
  const [index, setIndex] = useState(0);
  const [scanned, setScanned] = useState<StockLevelRow | null>(null);
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [log, setLog] = useState<CountedResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const scanRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);

  const current = mode === "scan" ? scanned : (queue[index] ?? null);
  const running = mode === "category" && queue.length > 0;
  const finished = running && index >= queue.length;

  // Focus follows the step: the quantity box whenever there's something to
  // count, the scan box whenever we're waiting for the next scan. This is the
  // whole "no mouse" promise, so it re-runs on every change of item.
  //
  // `pending` is in the deps for a reason that isn't obvious: the scan input
  // is disabled while a count is being posted, and calling `.focus()` on a
  // disabled input silently does nothing. Without re-running as the
  // transition settles, focus was simply lost after every scanned count and
  // the next scan went nowhere.
  useEffect(() => {
    if (current) quantityRef.current?.focus();
    else if (mode === "scan" && !pending) scanRef.current?.focus();
  }, [current, mode, pending, log.length]);

  const startCategory = (id: string) => {
    setCategoryId(id);
    setError(null);
    setQuantity("");
    setIndex(0);
    setQueue(id ? rows.filter((row) => row.category_id === id) : []);
  };

  const advance = () => {
    setQuantity("");
    if (mode === "scan") {
      setScanned(null);
      setCode("");
    } else {
      setIndex((i) => i + 1);
    }
  };

  const record = () => {
    if (!current || !quantity.trim()) return;
    setError(null);
    const row = current;
    const from = Number(row.on_hand);
    const to = Number(quantity);

    startTransition(async () => {
      const result = await setCountedStockAction(row.variant_id, row.on_hand, quantity, `Stock count`);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const entry: CountedResult = {
        variant_id: row.variant_id,
        label: `${row.product_name}${row.variant_name ? ` — ${row.variant_name}` : ""}`,
        from,
        to,
        delta: Number(result.data.delta),
      };
      setLog((prev) => [entry, ...prev].slice(0, 50));
      onCounted(entry);
      advance();
    });
  };

  const lookUp = () => {
    if (!code.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await resolveCodeAction(code.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const row = rows.find((r) => r.variant_id === result.data.variant_id);
      if (!row) {
        setError(`"${code.trim()}" isn't an item stocked at this store.`);
        setCode("");
        return;
      }
      setScanned(row);
      setQuantity("");
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Count stock</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Type what you counted and press Enter. Each one is recorded as you go.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-[var(--color-border)] p-0.5">
          {(["category", "scan"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
                setError(null);
                setQuantity("");
                setScanned(null);
                setCode("");
                setQueue([]);
                setCategoryId("");
                setIndex(0);
              }}
              className={`rounded px-3 py-1.5 text-sm ${
                mode === value
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              {value === "category" ? "By category" : "By scan"}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      {mode === "category" ? (
        <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
          Shelf to count
          <select
            value={categoryId}
            onChange={(e) => startCategory(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({rows.filter((r) => r.category_id === category.id).length})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-sm sm:max-w-md">
          Scan or type a code
          <input
            ref={scanRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              lookUp();
            }}
            disabled={pending || scanned !== null}
            placeholder="Scan a barcode"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
        </label>
      )}

      {current ? (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-lg font-semibold">
                {current.product_name}
                {current.variant_name ? ` — ${current.variant_name}` : ""}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                <span className="font-mono">{current.sku}</span> · system says{" "}
                <span className="tabular-nums">{Number(current.on_hand)}</span> on hand
              </p>
            </div>
            {running ? (
              <span className="text-sm tabular-nums text-[var(--color-text-muted)]">
                {index + 1} of {queue.length}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Counted
              <input
                ref={quantityRef}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    record();
                    return;
                  }
                  // Escape passes on this item without recording anything --
                  // the way to say "I'll come back to that one" without
                  // reaching for the mouse.
                  if (e.key === "Escape") {
                    e.preventDefault();
                    advance();
                  }
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                className="w-32 rounded-md border border-[var(--color-border)] px-3 py-2 text-lg tabular-nums outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <p className="pb-2 text-xs text-[var(--color-text-muted)]">
              {pending ? "Recording…" : "Enter to record and go to the next · Esc to skip"}
            </p>
          </div>
        </div>
      ) : null}

      {finished ? (
        <div className="rounded-md border border-[var(--color-border)] p-4 text-sm">
          <p className="font-medium">Shelf counted.</p>
          <p className="text-[var(--color-text-muted)]">
            {queue.length} item{queue.length === 1 ? "" : "s"} walked through. Pick another category to
            carry on.
          </p>
        </div>
      ) : null}

      {mode === "category" && !running ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Pick a category and the items come up one at a time, in the order they appear on the list
          below.
        </p>
      ) : null}

      {log.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-[var(--color-text-muted)]">
            Counted this session ({log.length})
          </h3>
          <ul className="max-h-40 overflow-y-auto text-sm">
            {log.map((entry, i) => (
              <li
                key={`${entry.variant_id}-${i}`}
                className="flex justify-between gap-4 border-t border-[var(--color-border)] py-1 first:border-0"
              >
                <span className="truncate">{entry.label}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                  {entry.delta === 0 ? (
                    `${entry.to} — no change`
                  ) : (
                    <>
                      {entry.from} → {entry.to}{" "}
                      <span className={entry.delta < 0 ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}>
                        ({entry.delta > 0 ? "+" : ""}
                        {entry.delta})
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
