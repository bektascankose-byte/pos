"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ShopCustomerProfile } from "@snappos/contracts";
import { placeOrderAction, type CheckoutState } from "@/app/checkout/actions";

function PlaceOrderButton({ total }: { total: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full text-base" disabled={pending}>
      {pending ? "Placing your order…" : `Place order · pay ${total} at pickup`}
    </button>
  );
}

function Field({
  id,
  label,
  type = "text",
  autoComplete,
  required = false,
  defaultValue,
  hint,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
        {!required ? <span className="font-normal text-[var(--muted)]"> (optional)</span> : null}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        required={required}
        defaultValue={defaultValue}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="field"
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-[var(--muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function CheckoutForm({
  customer,
  totalLabel,
  minimumAge,
}: {
  customer: ShopCustomerProfile | null;
  totalLabel: string;
  minimumAge: number | null;
}) {
  const [state, action] = useActionState<CheckoutState, FormData>(placeOrderAction, { error: null, fields: {} });
  const age = minimumAge ?? 21;

  return (
    <form action={action} className="flex flex-col gap-6" noValidate={false}>
      <section aria-labelledby="who-heading" className="flex flex-col gap-4">
        <h2 id="who-heading" className="display text-2xl font-bold uppercase">
          Who&apos;s picking up
        </h2>
        {customer ? (
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-sm">
            <p className="font-semibold">
              {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email}
            </p>
            <p className="text-[var(--muted)]">{customer.email}</p>
            <p className="mt-2 text-[var(--muted)]">We&apos;ll email you when your order is ready.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="first_name" label="First name" autoComplete="given-name" required defaultValue={state.fields.first_name} />
            <Field id="last_name" label="Last name" autoComplete="family-name" required defaultValue={state.fields.last_name} />
            <div className="sm:col-span-2">
              <Field
                id="email"
                label="Email"
                type="email"
                autoComplete="email"
                required
                defaultValue={state.fields.email}
                hint="For your order confirmation and to tell you when it's ready. We don't send offers unless you create an account and ask for them."
              />
            </div>
            <div className="sm:col-span-2">
              <Field id="phone" label="Phone" type="tel" autoComplete="tel" defaultValue={state.fields.phone} hint="In case we need to reach you about the order." />
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="note-heading" className="flex flex-col gap-2">
        <h2 id="note-heading" className="display text-2xl font-bold uppercase">
          Anything we should know
        </h2>
        <label htmlFor="note" className="sr-only">
          Note for the shop
        </label>
        <textarea id="note" name="note" rows={3} maxLength={500} defaultValue={state.fields.note} className="field" placeholder="Optional" />
      </section>

      <section aria-labelledby="age-heading" className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <h2 id="age-heading" className="text-sm font-semibold">
          Age
        </h2>
        <label htmlFor="age_attested" className="flex items-start gap-3 text-sm">
          <input id="age_attested" name="age_attested" type="checkbox" value="yes" required className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            I am {age} or older, and I will bring a valid government-issued photo ID when I pick up. I understand the
            shop will not hand over the order without it.
          </span>
        </label>
      </section>

      {state.error ? (
        <p role="alert" className="rounded-xl border border-[var(--danger)] px-4 py-3 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}

      <PlaceOrderButton total={totalLabel} />
    </form>
  );
}
