import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Brand, Category } from "@snappos/contracts";
import { createProductAction } from "../actions";

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; description?: string; brand?: string; category?: string }>;
}) {
  const { error, description, brand, category } = await searchParams;

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

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold">Add product</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        This creates a single-variant product. Adding more flavors or sizes to an existing product
        isn&apos;t supported here yet — create one product per SKU for now.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <form
        action={createProductAction}
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        <Field label="Name" name="name" defaultValue={description} required />
        <Field label="SKU" name="sku" required />
        <Field label="Barcode (UPC)" name="barcode" />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Cost" name="cost" placeholder="9.85" />
          <Field label="Price" name="price" placeholder="24.99" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Brand"
            name="brand_id"
            options={brands}
            defaultValue={brands.find((b) => b.name.toLowerCase() === brand?.toLowerCase())?.id}
          />
          <Select
            label="Category"
            name="category_id"
            options={categories}
            defaultValue={categories.find((c) => c.name.toLowerCase() === category?.toLowerCase())?.id}
          />
        </div>
        <button
          type="submit"
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
