"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { suggestVendorAction, assignVendorAction, createVendorForInvoiceAction } from "../actions";
import type { InvoiceImport, Vendor, VendorSuggestion } from "@snappos/contracts";

/**
 * A vendor code isn't printed on an invoice, so one is derived from the name:
 * initials for a multi-word name ("Midwest Goods Inc" -> "MGI"), the first
 * letters otherwise. It only has to be short, unique and recognizable, and
 * it's editable on the vendor's own page -- the alternative is making someone
 * invent one before they can file an invoice.
 */
function codeFromName(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "VENDOR";
  const initials = words.length > 1 ? words.map((w) => w[0]).join("") : words[0]!.slice(0, 6);
  return initials.toUpperCase().slice(0, 12);
}

/**
 * Which vendor sent this invoice.
 *
 * It matters beyond bookkeeping: committing writes `vendor_variants` keyed by
 * this vendor, which is what the second tier of matching reads. Filing every
 * invoice under the right vendor is what makes the next one from them match
 * without anyone's help -- and filing one under the wrong vendor quietly
 * teaches the matcher a lie, which is why nothing here assigns on its own.
 */
export function InvoiceVendorPanel({
  importId,
  invoiceImport,
  vendors,
  editable,
  onChanged,
}: {
  importId: string;
  invoiceImport: InvoiceImport;
  vendors: Vendor[];
  editable: boolean;
  onChanged: () => Promise<void>;
}) {
  const [suggestion, setSuggestion] = useState<VendorSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) await onChanged();
      else setError(result.error);
    });
  };

  const readVendor = () => {
    setError(null);
    startTransition(async () => {
      const result = await suggestVendorAction(importId);
      if (result.ok) setSuggestion(result.data);
      else setError(result.error);
    });
  };

  const extracted = suggestion?.extracted ?? null;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Vendor</h2>
          {invoiceImport.vendor_id ? (
            <p className="text-sm">
              <Link href={`/vendors/${invoiceImport.vendor_id}`} className="text-[var(--color-accent)]">
                {invoiceImport.vendor_name ?? "View vendor"}
              </Link>
            </p>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">
              Not filed under a vendor yet — this has to be set before the invoice can be committed.
            </p>
          )}
        </div>
        {editable ? (
          <button
            type="button"
            disabled={pending}
            onClick={readVendor}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
          >
            {pending ? "Reading..." : "Read vendor from this invoice"}
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-sm text-[var(--color-error)]">{error}</p> : null}

      {suggestion && !extracted?.name ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          Couldn&apos;t tell who sent this one — an invoice names both the seller and your store, and
          this document doesn&apos;t separate them clearly. Pick the vendor below.
        </p>
      ) : null}

      {extracted?.name ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-3">
          <div>
            <p className="text-sm">
              Read off the document: <span className="font-medium">{extracted.name}</span>
              <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                {Math.round(extracted.confidence * 100)}% confident
              </span>
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {[extracted.address_line1, extracted.city, extracted.region, extracted.postal_code]
                .filter(Boolean)
                .join(", ") || "no address on the document"}
              {extracted.phone ? ` · ${extracted.phone}` : ""}
              {extracted.payment_terms ? ` · ${extracted.payment_terms}` : ""}
            </p>
          </div>

          {suggestion && suggestion.matches.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--color-text-muted)]">
                Vendors you already have that look like this one:
              </p>
              {suggestion.matches.map((match) => (
                <div key={match.vendor_id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {match.name}
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      {match.code} · {Math.round(match.score * 100)}% alike
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={pending || !editable}
                    onClick={() => run(() => assignVendorAction(importId, match.vendor_id))}
                    className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-60"
                  >
                    File under {match.name}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">
              None of your existing vendors resemble this name.
            </p>
          )}

          <button
            type="button"
            disabled={pending || !editable}
            onClick={() =>
              run(() =>
                createVendorForInvoiceAction(importId, {
                  name: extracted.name!,
                  code: codeFromName(extracted.name!),
                  ...(extracted.phone ? { phone: extracted.phone } : {}),
                  ...(extracted.email ? { email: extracted.email } : {}),
                  ...(extracted.website ? { website: extracted.website } : {}),
                  ...(extracted.address_line1 ? { address_line1: extracted.address_line1 } : {}),
                  ...(extracted.city ? { city: extracted.city } : {}),
                  ...(extracted.region ? { region: extracted.region } : {}),
                  ...(extracted.postal_code ? { postal_code: extracted.postal_code } : {}),
                  ...(extracted.payment_terms ? { payment_terms: extracted.payment_terms } : {}),
                }),
              )
            }
            className="self-start rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            Create &quot;{extracted.name}&quot; as a new vendor
          </button>
        </div>
      ) : null}

      {editable ? (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-xs text-[var(--color-text-muted)]" htmlFor="vendor-picker">
            Or pick one:
          </label>
          <select
            id="vendor-picker"
            defaultValue=""
            disabled={pending}
            onChange={(e) => {
              const vendorId = e.target.value;
              if (vendorId) run(() => assignVendorAction(importId, vendorId));
            }}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            <option value="">Choose a vendor</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name} ({vendor.code})
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </section>
  );
}
