"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProductAction, suggestComplianceAction } from "../actions";
import type { Brand, Category } from "@snappos/contracts";

export function NewProductClient({
  brands,
  categories,
  storeId,
}: {
  brands: Brand[];
  categories: Category[];
  storeId: string | null;
}) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState(false);
  const [confidence, setConfidence] = useState(0);
  const [ageRestricted, setAgeRestricted] = useState(false);
  const [minimumAge, setMinimumAge] = useState("");
  const [regulatedClass, setRegulatedClass] = useState("");
  const [idScanRequired, setIdScanRequired] = useState(false);
  const [containsNicotine, setContainsNicotine] = useState(false);
  const [containsCannabinoid, setContainsCannabinoid] = useState(false);
  const [isSmokable, setIsSmokable] = useState(false);

  const [suggestPending, startSuggestTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();

  const handleSuggest = () => {
    setError(null);
    startSuggestTransition(async () => {
      const result = await suggestComplianceAction(nameRef.current?.value ?? "");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const s = result.data;
      setSuggested(true);
      setConfidence(s.confidence);
      setAgeRestricted(s.is_age_restricted);
      setMinimumAge(s.minimum_age !== null ? String(s.minimum_age) : "");
      setRegulatedClass(s.regulated_class ?? "");
      setIdScanRequired(s.id_scan_required);
      setContainsNicotine(s.contains_nicotine);
      setContainsCannabinoid(s.contains_cannabinoid);
      setIsSmokable(s.is_smokable);
    });
  };

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startCreateTransition(async () => {
      const result = await createProductAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/catalog/${result.data.id}?saved=1`);
    });
  };

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold">Add product</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        This creates a single-variant product. Adding more flavors or sizes to an existing product
        isn&apos;t supported here yet — create one product per SKU for now.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        ref={formRef}
        onSubmit={handleCreate}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        <Field label="Name" name="name" ref={nameRef} required />
        <Field label="SKU" name="sku" required />
        <Field label="Barcode (UPC)" name="barcode" />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Cost" name="cost" placeholder="9.85" />
          <Field label="Price" name="price" placeholder="24.99" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Brand" name="brand_id" options={brands} />
          <Select label="Category" name="category_id" options={categories} />
        </div>

        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggestPending}
          className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {suggestPending ? "Asking AI..." : "Suggest with AI"}
        </button>

        <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="age_restricted"
              checked={ageRestricted}
              onChange={(e) => setAgeRestricted(e.target.checked)}
            />
            This item is age-restricted (requires an ID check)
          </label>
          {suggested ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              AI suggestion ({Math.round(confidence * 100)}% confidence) — review before saving.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Minimum age
              <input
                name="minimum_age"
                placeholder="21"
                value={minimumAge}
                onChange={(e) => setMinimumAge(e.target.value)}
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Regulated class
              <select
                name="regulated_class"
                value={regulatedClass}
                onChange={(e) => setRegulatedClass(e.target.value)}
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">None</option>
                <option value="ends">Vape / ENDS</option>
                <option value="tobacco">Tobacco</option>
                <option value="consumable_hemp">Consumable hemp (THC)</option>
                <option value="kratom">Kratom</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="id_scan_required"
                checked={idScanRequired}
                onChange={(e) => setIdScanRequired(e.target.checked)}
              />
              Requires ID scan
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="contains_nicotine"
                checked={containsNicotine}
                onChange={(e) => setContainsNicotine(e.target.checked)}
              />
              Contains nicotine
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="contains_cannabinoid"
                checked={containsCannabinoid}
                onChange={(e) => setContainsCannabinoid(e.target.checked)}
              />
              Contains cannabinoid
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="is_smokable"
                checked={isSmokable}
                onChange={(e) => setIsSmokable(e.target.checked)}
              />
              Smokable
            </label>
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={createPending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {createPending ? "Creating..." : "Create product"}
        </button>
      </form>
    </div>
  );
}

const Field = ({
  label,
  name,
  placeholder,
  required,
  ref,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) => (
  <label className="flex flex-col gap-1 text-sm">
    {label}
    <input
      ref={ref}
      name={name}
      placeholder={placeholder}
      required={required}
      className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
    />
  </label>
);

function Select({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        name={name}
        defaultValue=""
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
