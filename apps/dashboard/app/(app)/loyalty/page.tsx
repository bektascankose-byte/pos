import { apiFetch, ApiError } from "@/lib/api";
import { updateLoyaltySettingsAction } from "./actions";
import type { LoyaltySettings } from "@snappos/contracts";

export default async function LoyaltySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { saved, error } = await searchParams;

  let settings: LoyaltySettings | null = null;
  let loadError: string | null = null;
  try {
    settings = await apiFetch<LoyaltySettings>(`/api/v1/loyalty/settings`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load loyalty settings.";
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Loyalty program</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        This configures the program's rules only. No points are earned on a sale or redeemed at
        checkout yet -- that part of loyalty isn't built. Turning this on just stores your rates
        for when it is.
      </p>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      {settings ? (
        <form
          action={updateLoyaltySettingsAction}
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
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Save
          </button>
        </form>
      ) : null}
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
