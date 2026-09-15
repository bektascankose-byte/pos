"use client";

import type { Vendor } from "@snappos/contracts";

/**
 * Every writable vendor field, in one place, used by both the add form and
 * the edit form. The two differ only in what they do with the values, so
 * keeping one set of inputs is what stops a field from being addable but not
 * editable (or the reverse) as this grows.
 *
 * `vendor` is undefined on the add form; each input simply starts empty.
 */
export function VendorFields({ vendor }: { vendor?: Vendor }) {
  const money = (minor: string | null): string => {
    if (minor === null || minor === "0") return "";
    const value = BigInt(minor);
    return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
  };

  return (
    <>
      <Section title="Who they are">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Code" name="code" defaultValue={vendor?.code ?? ""} placeholder="MWG" />
          <Field label="Name" name="name" defaultValue={vendor?.name ?? ""} placeholder="Midwest Goods" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Main phone" name="phone" defaultValue={vendor?.phone ?? ""} placeholder="(512) 555-0123" />
          <Field label="Main email" name="email" defaultValue={vendor?.email ?? ""} placeholder="orders@vendor.com" />
        </div>
        <Field label="Website" name="website" defaultValue={vendor?.website ?? ""} placeholder="vendor.com" />
      </Section>

      <Section
        title="Who to call"
        hint="The rep you actually deal with, as opposed to the vendor's main line."
      >
        <Field label="Sales rep" name="sales_rep_name" defaultValue={vendor?.sales_rep_name ?? ""} />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Rep phone"
            name="sales_rep_phone"
            defaultValue={vendor?.sales_rep_phone ?? ""}
            placeholder="(512) 555-0123"
          />
          <Field label="Rep email" name="sales_rep_email" defaultValue={vendor?.sales_rep_email ?? ""} />
        </div>
        <Field label="Other contact" name="contact_name" defaultValue={vendor?.contact_name ?? ""} />
      </Section>

      <Section title="Where they are">
        <Field label="Address" name="address_line1" defaultValue={vendor?.address_line1 ?? ""} />
        <Field label="Address line 2" name="address_line2" defaultValue={vendor?.address_line2 ?? ""} />
        <div className="grid grid-cols-4 gap-4">
          <div className="col-span-2">
            <Field label="City" name="city" defaultValue={vendor?.city ?? ""} />
          </div>
          <Field label="State" name="region" defaultValue={vendor?.region ?? ""} placeholder="TX" />
          <Field label="ZIP" name="postal_code" defaultValue={vendor?.postal_code ?? ""} />
        </div>
      </Section>

      <Section title="How we buy" hint="What the ordering screens use to warn you before you place an order.">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Payment terms"
            name="payment_terms"
            defaultValue={vendor?.payment_terms ?? ""}
            placeholder="NET30"
          />
          <Field
            label="Lead time (days)"
            name="lead_time_days"
            defaultValue={vendor ? String(vendor.lead_time_days) : ""}
            placeholder="7"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Minimum order ($)"
            name="minimum_order_minor"
            defaultValue={money(vendor?.minimum_order_minor ?? null)}
            placeholder="250.00"
          />
          <Field
            label="Free shipping over ($)"
            name="free_shipping_threshold_minor"
            defaultValue={money(vendor?.free_shipping_threshold_minor ?? null)}
            placeholder="500.00"
          />
        </div>
      </Section>

      <Section title="Notes">
        <Field label="Notes" name="notes" defaultValue={vendor?.notes ?? ""} textarea />
      </Section>
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  // The legend is the visible heading rather than a screen-reader-only copy
  // of one: a `sr-only` legend beside an identical `h2` makes every section
  // title announce twice.
  return (
    <fieldset className="mt-4 flex flex-col gap-3 border-t border-[var(--color-border)] pt-4 first:mt-0 first:border-0 first:pt-0">
      <legend className="text-sm font-medium">{title}</legend>
      {hint ? <p className="-mt-2 text-xs text-[var(--color-text-muted)]">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  textarea,
}: {
  label: string;
  name: string;
  defaultValue: string;
  placeholder?: string;
  textarea?: boolean;
}) {
  const className =
    "rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {textarea ? (
        <textarea name={name} defaultValue={defaultValue} placeholder={placeholder} rows={3} className={className} />
      ) : (
        <input name={name} defaultValue={defaultValue} placeholder={placeholder} className={className} />
      )}
    </label>
  );
}
