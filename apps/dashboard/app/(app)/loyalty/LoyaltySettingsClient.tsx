"use client";

import { useState, useTransition } from "react";
import { updateLoyaltySettingsAction } from "./actions";
import type { LoyaltySettings } from "@snappos/contracts";

export function LoyaltySettingsClient({ initialSettings }: { initialSettings: LoyaltySettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateLoyaltySettingsAction(formData);
      if (result.ok) {
        setSettings(result.data);
        setMessage({ kind: "success", text: "Saved." });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Loyalty program</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        This configures the program's rules only. No points are earned on a sale or redeemed at
        checkout yet -- that part of loyalty isn't built. Turning this on just stores your rates
        for when it is.
      </p>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_active" defaultChecked={settings.is_active} />
          Program is active
        </label>

        <Field label="Program name" name="name" defaultValue={settings.name} required />

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Points earned per dollar spent"
            name="earn_points_per_dollar"
            defaultValue={settings.earn_points_per_dollar}
            required
          />
          <Field
            label="Points needed per $1 of redemption"
            name="redemption_points_per_dollar"
            defaultValue={settings.redemption_points_per_dollar}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Minimum points to redeem"
            name="minimum_redemption_points"
            defaultValue={settings.minimum_redemption_points?.toString() ?? ""}
            placeholder="no minimum"
          />
          <Field
            label="Points expire after (days)"
            name="points_expire_after_days"
            defaultValue={settings.points_expire_after_days?.toString() ?? ""}
            placeholder="never"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
