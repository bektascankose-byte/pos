"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { bulkScanAction, addLineAction } from "../actions";
import type { ReceivingSession } from "@snappos/contracts";

type Mode = "box" | "one";

/**
 * Getting a delivery into the system, two ways.
 *
 * **Scan the box** takes a whole block at once: one code per line, pasted or
 * fired in by a scanner that sends Enter between reads. Twenty scans become
 * twenty lines in one submit, and the same code four times becomes a quantity
 * of four rather than four rows.
 *
 * **One at a time** is for when each item needs its own quantity or cost. The
 * quantity and cost boxes keep whatever was last entered, because a pallet is
 * usually cases of the same size at the same price and retyping "12" forty
 * times is how counting stops being done.
 */
export function ScanPanel({
  sessionId,
  onUpdated,
}: {
  sessionId: string;
  onUpdated: (session: ReceivingSession) => void;
}) {
  const [mode, setMode] = useState<Mode>("box");
  const [box, setBox] = useState("");
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const codeRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Focus sits where the next keystroke belongs, and returns there after each
  // submit -- a scanner fires the moment it reads, with nobody's hand on the
  // mouse to put the cursor back.
  useEffect(() => {
    if (pending) return;
    if (mode === "one") codeRef.current?.focus();
    else boxRef.current?.focus();
  }, [mode, pending, note]);

  const submitBox = () => {
    setError(null);
    startTransition(async () => {
      const result = await bulkScanAction(sessionId, box);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const lines = box.split(/[\r\n,]+/).map((l) => l.trim()).filter(Boolean).length;
      setBox("");
      setNote(`${lines} scan${lines === 1 ? "" : "s"} recorded.`);
      onUpdated(result.data);
    });
  };

  const submitOne = () => {
    if (!code.trim()) return;
    setError(null);
    const scanned = code.trim();
    startTransition(async () => {
      const result = await addLineAction(sessionId, { code: scanned, quantity, unit_cost: cost });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Quantity and cost deliberately stay put for the next item. The code
      // clears, because that is the one thing that is always different.
      setCode("");
      setNote(`${scanned} added.`);
      onUpdated(result.data);
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Scan what arrived</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            A code the catalog doesn&apos;t know is still recorded — you name it before it goes into
            stock.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-[var(--color-border)] p-0.5">
          {(["box", "one"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
                setError(null);
                setNote(null);
              }}
              className={`rounded px-3 py-1.5 text-sm ${
                mode === value
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              {value === "box" ? "Scan the box" : "One at a time"}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {note && !error ? <p className="text-sm text-[var(--color-success)]">{note}</p> : null}

      {mode === "box" ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            One code per line
            <textarea
              ref={boxRef}
              value={box}
              onChange={(e) => setBox(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter submits. A bare Enter has to stay as a
                // newline here: it is what the scanner sends between reads,
                // and swallowing it would end the batch after one item.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submitBox();
                }
              }}
              rows={10}
              placeholder={"Scan away — each read lands on its own line\n8410551234567\n8410551234567\nGB-PULSEX-MM"}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending || !box.trim()}
              onClick={submitBox}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
            >
              {pending ? "Recording..." : "Record these scans"}
            </button>
            <span className="text-xs text-[var(--color-text-muted)]">
              {box.split(/[\r\n,]+/).filter((l) => l.trim()).length} code
              {box.split(/[\r\n,]+/).filter((l) => l.trim()).length === 1 ? "" : "s"} · Ctrl+Enter to
              record · scanning the same code twice counts two
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Code
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submitOne();
              }}
              placeholder="Scan or type"
              className="w-56 rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Quantity
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submitOne();
              }}
              inputMode="decimal"
              className="w-24 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Unit cost ($)
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submitOne();
              }}
              inputMode="decimal"
              placeholder="optional"
              className="w-28 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <p className="pb-2 text-xs text-[var(--color-text-muted)]">
            {pending
              ? "Adding…"
              : "Enter adds it and clears the code — quantity and cost stay for the next one."}
          </p>
        </div>
      )}
    </section>
  );
}
