import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Brand, Category } from "@snappos/contracts";
import { createProductAction, suggestComplianceAction } from "../actions";

interface NewProductSearchParams {
  error?: string;
  name?: string;
  sku?: string;
  barcode?: string;
  cost?: string;
  price?: string;
  brand_id?: string;
  category_id?: string;
  tax_category_id?: string;
  suggested_is_restricted?: string;
  suggested_minimum_age?: string;
  suggested_id_scan_required?: string;
  suggested_regulated_class?: string;
  suggested_contains_nicotine?: string;
  suggested_contains_cannabinoid?: string;
  suggested_is_smokable?: string;
  suggested_confidence?: string;
}

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<NewProductSearchParams>;
}) {
  const params = await searchParams;

  let brands: Brand[] = [];
  let categories: Category[] = [];
  let loadError: string | null = null;
  const storeId = await primaryStoreId();
  try {
    [brands, categories] = await Promise.all([
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
    ]);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load brands and categories.";
  }

  const suggested = params.suggested_is_restricted !== undefined;
  const isRestricted = params.suggested_is_restricted === "true";

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold">Add product</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        This creates a single-variant product. Adding more flavors or sizes to an existing product
        isn&apos;t supported here yet — create one product per SKU for now.
      </p>

      {params.error ? <p className="text-sm text-[var(--color-error)]">{params.error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <form
        action={createProductAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        <Field label="Name" name="name" defaultValue={params.name} required />
        <Field label="SKU" name="sku" defaultValue={params.sku} required />
        <Field label="Barcode (UPC)" name="barcode" defaultValue={params.barcode} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Cost" name="cost" placeholder="9.85" defaultValue={params.cost} />
          <Field label="Price" name="price" placeholder="24.99" defaultValue={params.price} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Brand" name="brand_id" options={brands} defaultValue={params.brand_id} />
          <Select
            label="Category"
            name="category_id"
            options={categories}
            defaultValue={params.category_id}
          />
        </div>

        <button
          type="submit"
          formAction={suggestComplianceAction}
          formNoValidate
          className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
        >
          Suggest with AI
        </button>

        <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="age_restricted" defaultChecked={isRestricted} />
            This item is age-restricted (requires an ID check)
          </label>
          {suggested ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              AI suggestion ({Math.round(Number(params.suggested_confidence ?? "0") * 100)}% confidence)
              — review before saving.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Minimum age"
              name="minimum_age"
              placeholder="21"
              defaultValue={params.suggested_minimum_age}
            />
            <label className="flex flex-col gap-1 text-sm">
              Regulated class
              <select
                name="regulated_class"
                defaultValue={params.suggested_regulated_class ?? ""}
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
                defaultChecked={params.suggested_id_scan_required === "true"}
              />
              Requires ID scan
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="contains_nicotine"
                defaultChecked={params.suggested_contains_nicotine === "true"}
              />
              Contains nicotine
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="contains_cannabinoid"
                defaultChecked={params.suggested_contains_cannabinoid === "true"}
              />
              Contains cannabinoid
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="is_smokable"
                defaultChecked={params.suggested_is_smokable === "true"}
              />
              Smokable
            </label>
          </div>
        </fieldset>

        <button
          type="submit"
          formAction={createProductAction}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Create product
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        placeholder={placeholder}
        defaultValue={defaultValue}
        required={required}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function Select({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: { id: string; name: string }[];
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
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
